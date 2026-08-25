export interface SessionExtra {
	platform: string;
	
}

export type SessionType = 
	| "private"
	| "group"
	| "channel"

export interface Session {
	/** 框架会话ID */
	id: string;
	/** 会话类型 */
	type: SessionType;
}