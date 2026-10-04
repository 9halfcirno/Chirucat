import type { SessionType } from "../session";
import type { BotEvent } from "./event";

/**
 * 会话成员增加事件
 * @optional 该事件为可选, 因为不一定所有平台都会提供
 * @alpha 该事件正在设计阶段
 */
export interface MemberAddEvent extends BotEvent {
	/** 会话成员增加的type */
	type: "member.add";

	/** 成员的框架id */
	memberId: string;

	/** 成员昵称 */
	memberName: string;

	/** 会话窗口类型 */
	sessionType: SessionType;
	/** 会话id */
	sessionId: string;
}

/**
 * 会话成员减少事件, 包括主动退出/被踢等
 * @optional 该事件为可选, 因为不一定所有平台都会提供
 * @alpha 该事件正在设计阶段
 */
export interface MemberRemoveEvent extends BotEvent {
	/** 会话成员移除的type */
	type: "member.remove";

	/** 成员的框架id */
	memberId: string;

	/** 成员昵称 */
	memberName: string;

	/** 会话窗口类型 */
	sessionType: SessionType;
	/** 会话id */
	sessionId: string;
}