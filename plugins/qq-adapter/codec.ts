import type { MessageBlockReceive, MessageBlockSend } from "../../src/protocols/message-block";
import { MEDIA_FILE_TYPE, type QQFileType } from "./config";
import type { MediaSource, QQAttachment, QQUser } from "./types";

/**
 * 消息编解码
 *
 * 收(平台 -> 协议): {@link parseContent} 把 QQ 的 content 文本切成消息块,
 * 提及会被换成框架账号 uuid; {@link attachmentsToBlocks} 把附件补成媒体块。
 *
 * 发(协议 -> 平台): {@link splitSendBlocks} 把消息块拆成"文本"与"媒体"两组,
 * {@link stringifyContent} 把文本组渲染回 QQ 的 content 字符串。
 *
 * 本模块是纯函数, 不依赖上下文, 因此可以直接被自检脚本调用。
 */

/** 媒体消息段的类型 */
export type MediaBlockType = "image" | "video" | "audio";

/** 发送侧的提及段 */
export type SendMentionBlock = Extract<MessageBlockSend, { type: "mention" }>;

/**
 * 发送侧的文本类消息段
 *
 * 提及段额外允许携带 `name`: 协议的发侧提及只有 `id`(框架账号 uuid), 当该用户
 * 在目标平台没有账号时无法渲染成 @, 只能退化为昵称文本。`name` 不属于框架协议,
 * 仅作为适配器侧的展示兜底 —— 未提供时该提及会被丢弃(不编造内容)。
 */
export type SendTextBlock =
	| Extract<MessageBlockSend, { type: "text" }>
	| (SendMentionBlock & { name?: string });

/** 发送侧拆出的一段媒体, 已带好 QQ 的 file_type */
export type OutboundMedia = {
	type: MediaBlockType;
	fileType: QQFileType;
	source: MediaSource;
};

/** 发送侧消息块拆分结果 */
export type OutboundSplit = {
	/** 文本类消息段, 需经 {@link stringifyContent} 渲染 */
	texts: SendTextBlock[];
	/** 媒体段, 需经上传后逐条发送 */
	media: OutboundMedia[];
};

/**
 * QQ 消息 content 中的提及( @ )元素:
 * - 新格式: `<qqbot-at-user id="A1B2C3..." />`
 * - 旧格式: `<@A1B2C3...>`(官方已标记即将弃用, 但仍会下发, 两者都要兼容)
 *
 * 参考: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 */
const MENTION_PATTERN = /<@([^<>]+)>|<qqbot-at-user\s+id="([^"]*)"\s*\/>/g;

export interface MentionResolveOptions {
	/**
	 * 平台用户 id -> 框架账号 uuid
	 *
	 * 缺省或返回 `null` 时保留平台 id —— 解析不出账号也不该丢内容。
	 */
	resolveId?: (platformId: string) => string | null;
	/** 被提及用户的平台昵称, 以平台用户 id 为键 */
	names?: Map<string, string>;
}

/**
 * 将 QQ 消息 content 解析为消息块数组
 * @param content QQ 消息文本
 * @param options 提及消息段的转换配置
 */
export function parseContent(content: string, options: MentionResolveOptions = {}): MessageBlockReceive[] {
	const blocks: MessageBlockReceive[] = [];
	if (!content) return blocks;

	let cursor = 0;
	MENTION_PATTERN.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = MENTION_PATTERN.exec(content)) !== null) {
		const platformId = match[1] ?? match[2] ?? "";

		// 提及之前的普通文本
		const text = content.slice(cursor, match.index);
		if (text) blocks.push({ type: "text", text });
		cursor = match.index + match[0].length;

		blocks.push({
			type: "mention",
			id: options.resolveId?.(platformId) ?? platformId,
			name: options.names?.get(platformId) ?? ""
		});
	}

	// 末尾剩余文本
	const tail = content.slice(cursor);
	if (tail) blocks.push({ type: "text", text: tail });

	return blocks;
}

/** 转义正则元字符 */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 剥离消息开头的 @机器人 占位符
 *
 * `GROUP_MESSAGE_CREATE` 的 content 保留了 @机器人 的占位符(新旧两种格式都可能出现),
 * 这里统一剥掉开头那一个, 中间的 @别人 交给 {@link parseContent}。
 */
export function stripBotMention(text: string, mentions: QQUser[] | undefined): string {
	const me = (mentions ?? []).find((m) => m?.is_you === true);
	if (!me) return text;

	const botId = me.id || me.member_openid || me.user_openid;
	if (!botId) return text;

	const id = escapeRegExp(botId);
	const pattern = new RegExp(`^(?:<@${id}>|<qqbot-at-user\\s+id="${id}"\\s*\\/>)`);
	return text.replace(pattern, "").trimStart();
}

/**
 * 把附件转换为媒体消息块
 *
 * 只认 content_type 前缀是 image/video/audio 且带 url 的附件, 其余(文件等)忽略。
 */
export function attachmentsToBlocks(attachments: QQAttachment[] | undefined): MessageBlockReceive[] {
	const blocks: MessageBlockReceive[] = [];

	for (const attachment of attachments ?? []) {
		const url = attachment?.url;
		if (!url) continue;

		const contentType = attachment.content_type ?? "";
		if (contentType.startsWith("image")) {
			blocks.push({ type: "image", url });
		} else if (contentType.startsWith("video")) {
			blocks.push({ type: "video", url });
		} else if (contentType.startsWith("audio")) {
			blocks.push({ type: "audio", url });
		}
	}

	return blocks;
}

/**
 * 将消息段数组中的提及/文本段合并为 QQ 消息 content 字符串
 *
 * 提及段渲染为官方推荐格式 `<qqbot-at-user id="" />`。
 *
 * @param blocks 文本类消息段
 * @param resolve 框架账号 uuid -> 平台用户 id, 解析不到返回 null
 * @param allowMention 该会话是否支持 @ 能力(仅群聊支持)
 */
export function stringifyContent(
	blocks: SendTextBlock[],
	resolve: (id: string) => string | null,
	allowMention: boolean
): string {
	return blocks
		.map((block) => {
			if (block.type === "text") return block.text;

			const platformId = allowMention ? resolve(block.id) : null;
			// 非群聊或不认识该用户时, 退化为纯文本昵称, 避免丢内容
			if (!platformId) return block.name ? `@${block.name}` : "";
			return `<qqbot-at-user id="${platformId}" />`;
		})
		.join("");
}

/** 判断媒体段是否携带了可用内容 */
function isMediaBlock(
	block: MessageBlockSend
): block is Extract<MessageBlockSend, { type: MediaBlockType }> {
	return block.type === "image" || block.type === "video" || block.type === "audio";
}

/** 把媒体块归一成上传来源; 既无 url 也无 buffer 时返回 null */
function toMediaSource(
	block: Extract<MessageBlockSend, { type: MediaBlockType }>
): MediaSource | null {
	const url = block.url;
	if (typeof url === "string" && url) return { kind: "url", url };

	const buffer = block.buffer;
	if (buffer) return { kind: "buffer", buffer };

	return null;
}

/**
 * 按"文本 / 媒体"拆分发送侧消息块
 *
 * 文本合并成一条消息发送, 媒体逐条上传后单独发送 —— 这是 QQ 接口的能力边界
 * (一次请求只能带一个 media.file_info), 因此拆分是必要的, 不是偷懒。
 */
export function splitSendBlocks(blocks: MessageBlockSend[]): OutboundSplit {
	const texts: SendTextBlock[] = [];
	const media: OutboundMedia[] = [];

	for (const block of blocks) {
		if (block.type === "text" || block.type === "mention") {
			texts.push(block);
			continue;
		}

		if (!isMediaBlock(block)) continue;

		const source = toMediaSource(block);
		if (!source) continue;

		media.push({ type: block.type, fileType: MEDIA_FILE_TYPE[block.type], source });
	}

	return { texts, media };
}
