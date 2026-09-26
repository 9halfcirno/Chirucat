import type { MessageBlock } from "../protocols/message-block";

export type MessageReplyOption = {
	/** 引用的消息token/id, 为布尔true时代表引用当前消息 */
	quote: string | boolean;
}

export type MessageQuote = {
	/** 被引用消息id, 适配器无法提供时不存在 */
	id?: string;
	/** 被引用消息的纯文本内容 */
	text: string;

	/** 被引用消息的富文本块 */
	blocks: Array<MessageBlock>;

	/** 被引用消息的发送者 */
	sender: {
		id: string;
		unionId: string | null;
		name: string;
	}
}