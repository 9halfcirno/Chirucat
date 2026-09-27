import type { MessageBlock } from "../message-block";
import type { ActionResponse } from "./action";

export interface MessageSend {
	type: "message.send";

	/** 目标会话 */
	session: string;

	/** 消息内容 */
	message: string | MessageBlock[];

	/** 引用的消息 */
	quote?: string | null;
}

export type MessageSendResponse = {
	/** 成功发送后生成的消息 ID */
	id: string;

	/** 如果该消息支持被引用，返回引用凭证 */
	token?: string;
}