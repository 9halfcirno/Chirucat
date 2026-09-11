import type { Message } from "../entity/message";
import type { StatFlags, StatRecord } from "./types";

/**
 * 从消息实体提取一条统计记录。
 *
 * 只提取元数据(长度 / 类型 / 数量), 不保留消息原文 ——
 * 统计面向展示用途, 不需要也不应留存聊天内容。
 */
export function collect(message: Message, botId: string, flags: StatFlags): StatRecord {
	let textLen = 0;
	let imageCount = 0;
	let mentionCount = 0;

	for (const block of message.blocks) {
		switch (block.type) {
			case "text":
				textLen += block.text.length;
				break;
			case "image":
				imageCount++;
				break;
			case "mention":
				mentionCount++;
				break;
		}
	}

	// 适配器未提供消息块时, 退化为纯文本长度
	if (message.blocks.length === 0) textLen = message.text.length;

	return {
		time: message.time,
		botId,
		platform: message.platform,
		sessionId: message.session.id,
		sessionType: message.session.type,
		userId: message.sender.id,
		unionId: message.sender.unionId ?? "",
		textLen,
		imageCount,
		mentionCount,
		filtered: flags.filtered,
		isCommand: flags.isCommand,
	};
}
