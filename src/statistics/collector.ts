import type { Message } from "../entity/message";
import type { MessageSend } from "../protocols/action/message-send";
import type { MessageBlock } from "../protocols/message-block";
import type { StatFlags, StatRecord, StatSendMeta } from "./types";

type Measure = {
	/** 文本总长度 */
	textLen: number;
	/** 图片块数量 */
	imageCount: number;
	/** 提及块数量 */
	mentionCount: number;
};

/** 统计消息块的构成。只看块的数量与长度, 不保留内容 */
function measure(blocks: MessageBlock[]): Measure {
	const result: Measure = { textLen: 0, imageCount: 0, mentionCount: 0 };

	for (const block of blocks) {
		switch (block.type) {
			case "text":
				result.textLen += block.text.length;
				break;
			case "image":
				result.imageCount++;
				break;
			case "mention":
				result.mentionCount++;
				break;
		}
	}

	return result;
}

/**
 * 从消息实体提取一条统计记录(Bot 收到的消息)。
 *
 * 只提取元数据(长度 / 类型 / 数量), 不保留消息原文 ——
 * 统计面向展示用途, 不需要也不应留存聊天内容。
 */
export function collect(message: Message, botId: string, flags: StatFlags): StatRecord {
	const { textLen, imageCount, mentionCount } = measure(message.blocks);

	return {
		time: message.time,
		direction: "in",
		botId,
		platform: message.platform,
		sessionId: message.session.id,
		sessionType: message.session.type,
		userId: message.sender.id,
		unionId: message.sender.unionId ?? "",
		// 适配器未提供消息块时, 退化为纯文本长度
		textLen: message.blocks.length === 0 ? message.text.length : textLen,
		imageCount,
		mentionCount,
		filtered: flags.filtered,
		command: flags.command ?? "",
		isCommand: Boolean(flags.command),
	};
}

/**
 * 从发送动作提取一条统计记录(Bot 发出的消息)。
 *
 * 动作没有发送者与会话类型, 由调用方补齐; 记录的是"发出了这条消息",
 * 不代表平台一定投递成功。
 */
export function collectSend(action: MessageSend, meta: StatSendMeta): StatRecord {
	const blocks = typeof action.message === "string" ? [] : action.message;
	const { textLen, imageCount, mentionCount } = measure(blocks);

	return {
		time: Date.now(),
		direction: "out",
		botId: meta.botId,
		platform: meta.platform,
		sessionId: action.session,
		sessionType: meta.sessionType,
		userId: "",
		unionId: "",
		textLen: typeof action.message === "string" ? action.message.length : textLen,
		imageCount,
		mentionCount,
		filtered: false,
		isCommand: false,
		command: "",
	};
}
