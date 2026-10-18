
/**
 * 撤回一条消息
 * @optional 并非所有平台均会提供该API
 */
export interface MessageDelete {
	type: "message.delete";
	/** 目标会话 */
	session: string;
	/** 目标消息id */
	id: string;
}