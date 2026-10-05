import type { MessageBlockReceive, MessageBlockSend } from "../../src/protocols/message-block";
import { CQ_PATTERN } from "./constants";
import type { OneBotMessage, OneBotSegment } from "./types";

/**
 * 消息编解码
 *
 * 收(平台 -> 协议): {@link parseMessage} 把段数组或 CQ 码字符串统一解析成消息块。
 * 发(协议 -> 平台): {@link blocksToSegments} 把消息块渲染成段数组。
 *
 * 两种消息体形式(CQ 字符串是旧实现的产物)先统一归一成段数组再解析,
 * 避免维护两套等价的解析逻辑。
 *
 * 本模块是纯函数(平台标识转换通过 {@link Ob11CodecDeps} 注入), 可被自检脚本直接调用。
 */

/** 解析结果 */
export type ParsedMessage = {
	/** 解析出的消息块 */
	blocks: MessageBlockReceive[];
	/** 该消息所回复的消息 id; 无 reply 段时为 null */
	replyToId: string | null;
};

/** 编解码所需的框架能力 */
export interface Ob11CodecDeps {
	/** 平台用户 id -> 框架账号 uuid (收) */
	resolveUserId: (platformId: string) => string;
	/** 框架账号 uuid -> 平台用户 id (发); 解析不到返回 null */
	resolvePlatformId: (userId: string) => string | null;
}

/** 发送侧的提及段 */
export type SendMentionBlock = Extract<MessageBlockSend, { type: "mention" }>;

/**
 * 可发送的消息块
 *
 * 提及段额外允许携带 `name`: 协议的发侧提及只有 `id`(框架账号 uuid), 当该用户
 * 在目标平台没有账号时无法渲染成 @, 只能退化为昵称文本。`name` 不属于框架协议,
 * 仅作为适配器侧的展示兜底。
 */
export type SendableBlock =
	| Extract<MessageBlockSend, { type: "text" | "image" | "video" | "audio" }>
	| (SendMentionBlock & { name?: string });

// -------------------- 收: 平台 -> 协议 --------------------

/**
 * 解析一条消息
 * @param message 段数组或 CQ 码字符串
 * @param deps 平台标识转换
 */
export function parseMessage(message: OneBotMessage | undefined, deps: Ob11CodecDeps): ParsedMessage {
	return segmentsToParsed(normalizeSegments(message), deps);
}

/** 把两种消息体形式统一成段数组 */
export function normalizeSegments(message: OneBotMessage | undefined): OneBotSegment[] {
	if (Array.isArray(message)) {
		return message.filter(
			(seg): seg is OneBotSegment => Boolean(seg) && typeof seg === "object"
		);
	}

	if (typeof message === "string") return cqStringToSegments(message);

	return [];
}

/**
 * 解析 CQ 码字符串
 *
 * 正则带 `g` 标志且有 `lastIndex` 状态, 因此每次都新建一个实例 ——
 * 共享模块级正则会在嵌套调用时静默丢字符。
 */
export function cqStringToSegments(str: string): OneBotSegment[] {
	const segments: OneBotSegment[] = [];
	const pattern = new RegExp(CQ_PATTERN.source, "g");

	let cursor = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(str)) !== null) {
		if (match.index > cursor) pushTextSegment(segments, str.slice(cursor, match.index));
		segments.push({ type: match[1] ?? "", data: parseCqParams(match[2] ?? "") });
		cursor = match.index + match[0].length;
	}

	if (cursor < str.length) pushTextSegment(segments, str.slice(cursor));

	return segments;
}

/** CQ 参数解析: `,a=1,b=2` -> `{a:"1", b:"2"}` */
export function parseCqParams(str: string): Record<string, string> {
	const data: Record<string, string> = {};
	if (!str) return data;

	for (const pair of str.split(",")) {
		if (!pair) continue;
		const idx = pair.indexOf("=");
		if (idx === -1) continue;
		data[pair.slice(0, idx).trim()] = unescapeCq(pair.slice(idx + 1));
	}

	return data;
}

/** CQ 码的实体反转义 */
export function unescapeCq(str: string): string {
	return str
		.replace(/&#91;/g, "[")
		.replace(/&#93;/g, "]")
		.replace(/&#44;/g, ",")
		.replace(/&amp;/g, "&");
}

function pushTextSegment(segments: OneBotSegment[], raw: string): void {
	const text = unescapeCq(raw);
	if (text) segments.push({ type: "text", data: { text } });
}

/** 段数组 -> 消息块 */
export function segmentsToParsed(segments: OneBotSegment[], deps: Ob11CodecDeps): ParsedMessage {
	const blocks: MessageBlockReceive[] = [];
	let replyToId: string | null = null;

	for (const seg of segments) {
		if (!seg || typeof seg !== "object") continue;
		const data = seg.data ?? {};

		switch (seg.type) {
			case "text": {
				const text = data.text;
				if (text) blocks.push({ type: "text", text: String(text) });
				break;
			}

			case "image": {
				const url = mediaUrl(data);
				if (url) blocks.push({ type: "image", url });
				break;
			}

			case "record": {
				const url = mediaUrl(data);
				if (url) blocks.push({ type: "audio", url });
				break;
			}

			case "video": {
				const url = mediaUrl(data);
				if (url) blocks.push({ type: "video", url });
				break;
			}

			case "at": {
				blocks.push(atBlock(data, deps));
				break;
			}

			case "face": {
				blocks.push({ type: "text", text: `[表情${data.id ?? ""}]` });
				break;
			}

			case "reply": {
				// reply 段不产生消息块, 但它表明本条消息在回复另一条消息
				const id = data.id;
				if (id !== undefined && id !== null && id !== "") replyToId = String(id);
				break;
			}

			default:
				// json / forward / mface 等暂不映射
				break;
		}
	}

	return { blocks, replyToId };
}

/** 媒体段取地址: 优先 url, 退化为 file */
function mediaUrl(data: Record<string, any>): string {
	const value = data.url ?? data.file;
	return value === undefined || value === null ? "" : String(value);
}

/** at 段 -> mention 块; @全体成员 无对应账号, 退化为文本 */
function atBlock(data: Record<string, any>, deps: Ob11CodecDeps): MessageBlockReceive {
	const qq = data.qq;
	if (qq === undefined || qq === null || qq === "all") {
		return { type: "text", text: "@全体成员" };
	}
	return { type: "mention", id: deps.resolveUserId(String(qq)) };
}

// -------------------- 发: 协议 -> 平台 --------------------

/**
 * 消息块 -> 段数组
 *
 * 无法渲染的块会被跳过(而不是产出空段), 因此调用方需要判断结果是否为空。
 */
export function blocksToSegments(blocks: SendableBlock[], deps: Ob11CodecDeps): OneBotSegment[] {
	const segments: OneBotSegment[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case "text":
				if (block.text) segments.push({ type: "text", data: { text: String(block.text) } });
				break;

			case "image":
				pushMediaSegment(segments, "image", block);
				break;

			case "video":
				pushMediaSegment(segments, "video", block);
				break;

			case "audio":
				pushMediaSegment(segments, "record", block);
				break;

			case "mention":
				segments.push(mentionSegment(block, deps));
				break;
		}
	}

	return segments;
}

/** 媒体块 -> 媒体段(OneBot 用同一个 file 字段承载 URL 与 base64) */
function pushMediaSegment(
	segments: OneBotSegment[],
	type: string,
	block: Extract<MessageBlockSend, { type: "image" | "video" | "audio" }>
): void {
	const file = toFileValue(block);
	if (!file) return;
	segments.push({ type, data: { file } });
}

/**
 * 把媒体块归一成 OneBot 的 `file` 取值
 *
 * - URL 直接透传, 由实现端自行下载;
 * - Buffer 转成 `base64://`, 支持平台协议中的"本地 Buffer 发送意图"。
 */
function toFileValue(block: Extract<MessageBlockSend, { type: "image" | "video" | "audio" }>): string | null {
	const url = block.url;
	if (typeof url === "string" && url) return url;

	const buffer = block.buffer;
	if (buffer) return `base64://${toBase64(buffer)}`;

	return null;
}

/** ArrayBufferView -> base64(不复制同一块内存) */
function toBase64(view: NodeJS.ArrayBufferView): string {
	const buf = Buffer.isBuffer(view) ? view : Buffer.from(view.buffer, view.byteOffset, view.byteLength);
	return buf.toString("base64");
}

/** mention 块 -> at 段; 平台账号解析不到时退化为昵称文本 */
function mentionSegment(block: SendMentionBlock & { name?: string }, deps: Ob11CodecDeps): OneBotSegment {
	const platformId = deps.resolvePlatformId(block.id);
	if (platformId) return { type: "at", data: { qq: platformId } };
	return { type: "text", data: { text: block.name ? `@${block.name}` : "" } };
}

// -------------------- 其他 --------------------

/** 把消息块拼成一段可读文本(用于内容过滤与日志) */
export function blocksToText(blocks: MessageBlockReceive[]): string {
	let out = "";

	for (const block of blocks) {
		switch (block.type) {
			case "text":
				out += block.text;
				break;
			case "image":
				out += "[图片]";
				break;
			case "mention":
				out += `@${block.name ?? block.id}`;
				break;
			default:
				break;
		}
	}

	return out;
}
