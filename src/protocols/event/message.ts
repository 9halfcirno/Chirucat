import type { MessageBlock } from "../message-block";
import type { SessionType } from "../session";
import type { BotEvent } from "./event";

/**
 * 消息创建事件
 * @baseline 该事件为最基础的Bot功能之一
 */
export interface MessageCreateEvent extends BotEvent {
	/** 消息创建事件的type */
	type: "message.create";

	messageId: string;

	/** 可以引用该消息的引用id */
	quoteToken: string;

	/** 发送者框架id, 从UserManager获取 */
	senderId: string;
	/** 发送者昵称 */
	senderName: string;

	/** 会话窗口类型 */
	sessionType: SessionType;
	/** 会话id */
	sessionId: string;

	/** 消息纯文本内容 */
	text: string;
	/** 消息富文本内容 */
	richContent: Array<MessageBlock>;

	quote?: MessageQuote;
}

/**
 * 消息删除/撤回事件
 * @optional 该事件为可选, 因为不一定所有平台都会提供
 * @alpha 该事件正在设计阶段
 */
export interface MessageDeleteEvent extends BotEvent {
	type: "message.delete";

	/** 撤回的消息ID */
	messageId: string;

	/** 操作者框架ID */
	operatorId: string;
	/** 操作者昵称 */
	operatorName: string;

	/** 会话窗口类型 */
	sessionType: SessionType;
	/** 会话id */
	sessionId: string;
}

export interface MessageQuote {
	/** 被引用消息id, 拿不到就是空 */
	messageId?: string;
	/** 消息纯文本内容 */
	text: string;
	/** 消息富文本内容 */
	richContent: Array<MessageBlock>;

	/** 发送者框架id, 从UserManager获取 */
	senderId: string;
	/** 发送者昵称 */
	senderName: string;
}