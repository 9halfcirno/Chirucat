import type { MessageBlock } from "../../../src/protocols/message-block";

/**
 * QQ 消息 content 中的提及( @ )元素:
 * - 新格式: `<qqbot-at-user id="A1B2C3..." />`
 * - 旧格式: `<@A1B2C3...>`（官方已标记即将弃用, 但仍会下发, 两者都要兼容）
 *
 * 参考: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 */
const MENTION_PATTERN = /<@([^<>]+)>|<qqbot-at-user\s+id="([^"]*)"\s*\/>/g;

export interface MentionResolveOptions {
	/**
	 * 平台用户id -> 框架账号uuid
	 * 解析不到时返回 null
	 */
	resolveId: (platformId: string) => string | null;
	/** 被提及用户的平台昵称, 以平台用户id为键 */
	names?: Map<string, string>;
}

/**
 * 将 QQ 消息 content 解析为消息段数组
 * @param content QQ 消息文本
 * @param options 提及消息段的转换配置, 缺省时提及段的 id 直接使用平台id
 */
export function parseContent(content: string, options?: MentionResolveOptions): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	if (!content) return blocks;

	let cursor = 0;
	MENTION_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = MENTION_PATTERN.exec(content)) !== null) {
		const platformId = match[1] ?? match[2] ?? "";

		// 提及前的普通文本
		const text = content.slice(cursor, match.index);
		if (text) blocks.push({ type: "text", text });
		cursor = match.index + match[0].length;

		blocks.push({
			type: "mention",
			id: options ? (options.resolveId(platformId) ?? platformId) : platformId,
			name: options?.names?.get(platformId) ?? ""
		});
	}

	// 末尾剩余文本
	const tail = content.slice(cursor);
	if (tail) blocks.push({ type: "text", text: tail });

	return blocks;
}

/**
 * 将消息段数组中的提及/文本段合并为 QQ 消息 content 字符串
 * 提及段渲染为官方推荐格式 `<qqbot-at-user id="" />`
 * @param blocks 消息段数组
 * @param resolve 框架账号uuid -> 平台用户id, 解析不到返回 null
 * @param allowMention 该会话是否支持 @能力(仅群聊支持)
 */
export function stringifyContent(
	blocks: Array< Extract<MessageBlock, { type: "text" | "mention" }> >,
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
