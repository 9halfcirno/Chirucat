export interface MessageDelete {
	type: "message.delete";
	/** 目标会话 */
	session: string;
	/** 目标消息id */
	id: string;
}