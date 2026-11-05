import type { OutboundMedia } from "./codec";
import type { ImageSize } from "./img-size";

/**
 * 发送侧消息的自动路由
 *
 * 三条规则(判定逻辑集中在这里, actions 只管发送):
 * - 图文混合(文本 + 全部为图片) -> 一条 markdown(msg_type=2):
 *   - 本地 Buffer 图片走素材通道(上传去重, 消息里嵌 qqbot-media:// URL);
 *   - http(s) 公网图片直接外链内嵌 —— 不占素材配额、不产生下载流量, 尺寸用
 *     img-size 的 Range 探测补齐;
 * - 纯富媒体(无文本) -> 逐条 msg_type=7, 沿用 file_info 通道;
 * - 纯文本 -> markdown(msg_type=2)。
 *
 * 图文合并成一条是实测验证过的能力。外链渲染依赖对方 CDN 无防盗链, 若某来源
 * 频繁裂图, 应改回由业务侧提供 Buffer 走素材通道。
 */

/** 可参与图文混排的 image 块(Buffer 或 http(s) 链接) */
export type MixedImageMedia = OutboundMedia & { type: "image" };

/** 仅放行 http(s): 其他 scheme(javascript: 等)不得进入 markdown 链接语法 */
export function isHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

export function isMixedImage(item: OutboundMedia): item is MixedImageMedia {
	if (item.type !== "image") return false;
	return item.source.kind === "buffer" || isHttpUrl(item.source.url);
}

/** 路由判定结果 */
export type SendPlan =
	| { kind: "text" }
	| { kind: "markdown-mixed"; images: MixedImageMedia[] }
	| { kind: "sequential"; images: OutboundMedia[] };

/**
 * 决定这批拆分结果怎么发
 *
 * `content` 是渲染后的文本(可能为空串); 无文本但有媒体时尊重"纯富媒体走 7"的规则,
 * 即使全是图片也不合并 —— 单发图片消息的展示形态与内嵌 markdown 不同。
 * `mergeMixedMarkdown`(来自配置 mixed_markdown): false 时图文永不合并, 直接按
 * "文本一条 + 媒体逐条" 发送; 合并路径失败时 actions 本来也会回退到这条路径。
 */
export function planSend(content: string, media: OutboundMedia[], mergeMixedMarkdown = true): SendPlan {
	if (media.length === 0) return { kind: "text" };

	const hasText = content.trim() !== "";
	if (mergeMixedMarkdown && hasText && media.every(isMixedImage)) {
		return { kind: "markdown-mixed", images: media };
	}
	return { kind: "sequential", images: media };
}

/** markdown 正文长度上限: 平台约 5000, 留余量防超长素材 URL 撑爆 */
const MAX_MARKDOWN_LENGTH = 4500;

/**
 * 有序混排片段: 按原始消息块顺序给到的文本段与已解析图片段
 *
 * 文本段之间直接拼接(保持 "你好, 世界" 这类跨段连续性), 图片独立成行;
 * 空白文本段丢弃(图片前后的排版空格没有信息量, 反而会把行距拉乱)。
 */
export type MixedSegment =
	| { kind: "text"; value: string }
	| { kind: "image"; url: string; size?: ImageSize | undefined };

/**
 * 按最大高度等比缩放显示尺寸
 *
 * maxH <= 0 或图未超高时原样返回; 宽高用同一比例换算并至少 1px,
 * 保证显示宽高比与源图一致(只压高不缩宽会被平台拉伸变形)。
 */
export function clampDisplaySize(size: ImageSize, maxH: number): ImageSize {
	if (maxH <= 0 || size.height <= maxH) return size;
	const ratio = maxH / size.height;
	return {
		width: Math.max(1, Math.round(size.width * ratio)),
		height: Math.max(1, Math.round(size.height * ratio))
	};
}

function imageTag(url: string, size: ImageSize | undefined): string {
	// 空格会截断 markdown 链接; 素材 URL 是 base64url 无此问题, 公网 URL 常见含空格
	const safe = url.replaceAll(" ", "%20");
	return size
		? `![图片 #${size.width}px #${size.height}px](${safe})`
		: `![图片 #0px #0px](${safe})`;
}

/**
 * 按片段顺序拼装图文混排的 markdown
 *
 * 尺寸标签来自图片自身头部解析(img-size): 不带 `#宽px #高px` 时 QQ 客户端
 * 会把图拉伸到统一框, 表情包会变形得很明显。解析不到按 `#0px #0px` 交给平台自适应。
 *
 * @param maxImageHeight 显示高度上限(px, 0=不限制, 来自 material.max_image_height),
 *   超高图片等比缩放
 * @returns 无有效内容或超长时返回 null, 由调用方回退"先文本后媒体"的逐条发送
 */
export function renderMixedSegments(segments: MixedSegment[], maxImageHeight = 0): string | null {
	const parts: string[] = [];
	let textBuf = "";
	const flush = () => {
		const chunk = textBuf.trim();
		if (chunk) parts.push(chunk);
		textBuf = "";
	};
	for (const seg of segments) {
		if (seg.kind === "text") {
			textBuf += seg.value;
			continue;
		}
		flush();
		parts.push(imageTag(seg.url, seg.size ? clampDisplaySize(seg.size, maxImageHeight) : undefined));
	}
	flush();

	if (parts.length === 0) return null;
	const body = parts.join("\n\n");
	// 首字符 [ 的转义不在这里做: 所有 msg_type=2 出口在 actions.sendText 统一收口
	return body.length > MAX_MARKDOWN_LENGTH ? null : body;
}
