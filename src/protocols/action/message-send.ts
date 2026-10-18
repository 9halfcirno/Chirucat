import type { MessageBlockSend } from "../message-block";

/**
 * 向指定会话发送一条消息
 * @baseline 最基础的Bot交互Action
 */
export interface MessageSend {
	type: "message.send";

	/** 目标会话 */
	session: string;

	/** 消息内容 */
	message: string | MessageBlockSend[];

	/** 引用的消息 */
	quote?: string | null;
}

export type MessageSendResponse = {
	/** 成功发送后生成的消息 ID */
	id: string;

	/** 如果该消息支持被引用，返回引用凭证 */
	token?: string;
}