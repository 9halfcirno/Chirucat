export type SessionType = 
	| "private"
	| "group"
	| "channel"

export interface Session {
	/** 框架会话ID */
	id: string;
	/** 会话显示名称, 适配器尽量提供, 无法提供时为空字符串 */
	name?: string;
	/** 会话类型 */
	type: SessionType;
	/**
	 * 该会话所属的逻辑会话组 ID(union)。
	 *
	 * 同一物理会话在不同适配器/平台下会得到不同的 `id`, 但经会话绑定后会共享
	 * 同一个 `unionId` —— 跨适配器去重、受理人判定这类逻辑应当以它而非 `id` 为准。
	 * 会话尚未登记(或查不到)时为 `null`。
	 */
	unionId: string | null;
}