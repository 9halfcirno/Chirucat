import type { MessageBlock } from "../message-block";

export interface MessageSend {
	type: "message.send",

	/** 目标会话 */
	session: string;

	/** 消息内容 */
	message: string | MessageBlock[];
}