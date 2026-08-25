import type { MessageBlock } from "../message-block";
import type { SessionType } from "../session";
import type { BotEvent } from "./event";

export interface MessageCreateEvent extends BotEvent {
	type: "message.create";

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
}