import type { OutboundMedia } from "./codec";
import type { ImageSize } from "./img-size";
import type { MediaSource } from "./types";
import { resolveFileName } from "./media";

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

/** 可进素材通道的图片: 本地 Buffer 的 image 块 */
export type BufferImageMedia = OutboundMedia & { source: Extract<MediaSource, { kind: "buffer" }> };

/** 可参与图文混排的 image 块(Buffer 或 http(s) 链接) */
export type MixedImageMedia = OutboundMedia & { type: "image" };

export function isBufferImage(item: OutboundMedia): item is BufferImageMedia {
	return item.type === "image" && item.source.kind === "buffer";
}

/** 仅放行 http(s): 其他 scheme(javascript: 等)不得进入 markdown 链接语法 */
export function isMixedImage(item: OutboundMedia): item is MixedImageMedia {
	if (item.type !== "image") return false;
	return item.source.kind === "buffer" || /^https?:\/\//i.test(item.source.url);
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

/** markdown 里的一张内嵌图: 素材 URL + 可选的原图尺寸 */
export type MixedMarkdownImage = { url: string; size?: ImageSize | undefined };

/**
 * 拼装图文混排的 markdown
 *
 * 尺寸标签来自图片自身头部解析(img-size): 不带 `#宽px #高px` 时 QQ 客户端
 * 会把图拉伸到统一框, 表情包会变形得很明显。解析不到就不写尺寸(文档中尺寸可选)。
 *
 * @returns 超长时返回 null, 由调用方回退"先文本后媒体"的逐条发送
 */
export function buildMixedMarkdown(text: string, images: MixedMarkdownImage[]): string | null {
	const rendered = images
		.map((img) => {
			// 空格会截断 markdown 链接; 素材 URL 是 base64url 无此问题, 公网 URL 常见含空格
			const url = img.url.replaceAll(" ", "%20");
			return img.size
				? `![图片 #${img.size.width}px #${img.size.height}px](${url})`
				: `![图片 #0px #0px](${url})`;
		})
		.join("\n");
	const body = `${text}\n\n${rendered}`;
	if (body.length > MAX_MARKDOWN_LENGTH) return null;
	// 文本以 [ 开头会被 markdown 当作链接语法的一部分, 转义首字符即可
	return body.startsWith("[") ? `\\${body}` : body;
}

/**
 * 素材通道上传时申报的文件名
 *
 * 扩展名由文件头(magic bytes)推断, 与 uploader 同一套规则 —— 避免"名字说 png 实际 webp"
 * 导致 prepare 申报的 content_type 与字节不符。
 */
export function materialFileName(item: BufferImageMedia): string {
	return resolveFileName(item.source.buffer, item.fileType);
}
