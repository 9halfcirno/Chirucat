import type { MessageBlockReceive } from "../message-block";
import type { SessionType } from "../../entity/session";
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
	senderName?: string;

	/** 会话窗口类型 */
	sessionType: SessionType;
	/** 会话id */
	sessionId: string;
	/** 会话名称, 尽量提供, 私聊直接填用户名, 频道场景可以填`guild-channel`这样格式的名字 */
	sessionName?: string;

	/** 消息纯文本内容 */
	text: string;
	/** 消息富文本内容 */
	richContent: Array<MessageBlockReceive>;

	/**
	 * 该消息是否 @ 了本 Bot(即收到该事件的适配器自身)。
	 *
	 * 私聊恒为 `false`; 平台不提供 @ 信息时缺省(`undefined`)表示"未知",
	 * 不要用 `false` 冒充"确定没有 @"。
	 */
	mentionedSelf?: boolean;

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
	richContent: Array<MessageBlockReceive>;

	/** 发送者框架id, 从UserManager获取 */
	senderId: string;
	/** 发送者昵称 */
	senderName: string;
}