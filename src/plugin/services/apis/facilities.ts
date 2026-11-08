import type { SessionManager } from "../../../internal/session-manager";
import type { UserManager } from "../../../internal/user-manager";
import type { UserProfileManager } from "../../../internal/user-profile";
import type { StatisticsManager } from "../../../statistics/manager";

/**
 * 服务插件能看到的框架设施
 *
 * 与 `PluginUserAPI` / `AdapterUserAPI` 的分工: 那两套是"插件只查不建"的收窄面,
 * 服务插件是框架级可信代码, 读写都开放。这里用 `Pick` 而不是手抄签名 ——
 * 方法集合是白名单, 但签名永远跟随管理器本身, 不会出现两份定义漂移。
 *
 * 运行期由普通包装对象实现(见下面的 `create*API`), 不是 Proxy:
 * - 方法逐个显式列出, `init` / `close` / `db` 这类生命周期入口**根本不存在**,
 *   既拿不到也不会被 `as any` 变出来;
 * - 每次调用时才解析设施, 因此包装对象可以在插件里安全地存下来(`const u = ctx.user`),
 *   不需要为了"视图不能缓存"写 getter;
 * - 身份稳定: 同一个上下文的 `ctx.user` 永远是同一个对象, 可做比较与 WeakMap 键。
 */

/** 用户标识视图: 查询、绑定关系与列表 */
export const USER_KEYS = [
	"find", "query", "queryMany", "has", "get", "getUnion", "getLast",
	"bind", "unbind", "restore", "listMembers", "list", "overview",
] as const;
export type UserAPI = Pick<UserManager, (typeof USER_KEYS)[number]>;

/** 会话标识视图: 查询、绑定关系与成员 */
export const SESSION_KEYS = [
	"find", "query", "queryMany", "has", "get", "getUnion", "unionOf", "getLast",
	"bind", "unbind", "restore", "listMembers",
] as const;
export type SessionAPI = Pick<SessionManager, (typeof SESSION_KEYS)[number]>;

/** 用户档案视图: 昵称等展示信息 */
export const PROFILE_KEYS = ["touch", "get", "getMany"] as const;
export type ProfileAPI = Pick<UserProfileManager, (typeof PROFILE_KEYS)[number]>;

/** 统计查询视图: 采集与生命周期入口不在其中 */
export const STATISTICS_KEYS = [
	"summary", "timeline", "rank", "commands", "bots", "userActivity",
] as const;
export type StatisticsAPI = Pick<StatisticsManager, (typeof STATISTICS_KEYS)[number]>;

/**
 * 设施解析器
 *
 * 由上下文提供: 返回当前设施实例, 不可用(未初始化 / 已释放)时抛 StateError。
 * 包装对象不持有管理器本体, 只持有这个闭包 —— 于是 Core 释放后, 已经发出去的
 * 视图会在下一次调用如实失败, 而不是继续读写一个已关闭的连接。
 */
export type FacilityResolver<T> = () => T;

export function createUserAPI(get: FacilityResolver<UserManager>): UserAPI {
	return {
		find: (platform, id) => get().find(platform, id),
		query: (accountUuid) => get().query(accountUuid),
		queryMany: (accountIds) => get().queryMany(accountIds),
		has: (platform, id) => get().has(platform, id),
		get: (platform, id) => get().get(platform, id),
		getUnion: (accountId) => get().getUnion(accountId),
		getLast: (accountId) => get().getLast(accountId),
		bind: (internalId, accountUuid) => get().bind(internalId, accountUuid),
		unbind: (internalId, accountUuid) => get().unbind(internalId, accountUuid),
		restore: (accountId) => get().restore(accountId),
		listMembers: (internalId) => get().listMembers(internalId),
		list: (query) => get().list(query),
		overview: () => get().overview(),
	};
}

export function createSessionAPI(get: FacilityResolver<SessionManager>): SessionAPI {
	return {
		find: (platform, type, id) => get().find(platform, type, id),
		query: (id) => get().query(id),
		queryMany: (ids) => get().queryMany(ids),
		has: (platform, type, id) => get().has(platform, type, id),
		get: (platform, type, id) => get().get(platform, type, id),
		getUnion: (sessionId) => get().getUnion(sessionId),
		unionOf: (sessionId) => get().unionOf(sessionId),
		getLast: (sessionId) => get().getLast(sessionId),
		bind: (internalId, sessionUuid) => get().bind(internalId, sessionUuid),
		unbind: (internalId, sessionUuid) => get().unbind(internalId, sessionUuid),
		restore: (sessionId) => get().restore(sessionId),
		listMembers: (internalId) => get().listMembers(internalId),
	};
}

export function createProfileAPI(get: FacilityResolver<UserProfileManager>): ProfileAPI {
	return {
		touch: (accountId, name) => get().touch(accountId, name),
		get: (accountId) => get().get(accountId),
		getMany: (accountIds) => get().getMany(accountIds),
	};
}

export function createStatisticsAPI(get: FacilityResolver<StatisticsManager>): StatisticsAPI {
	return {
		summary: (range) => get().summary(range),
		timeline: (range, bucketMs) => get().timeline(range, bucketMs),
		rank: (range, by, limit) => get().rank(range, by, limit),
		commands: (range, limit) => get().commands(range, limit),
		bots: () => get().bots(),
		userActivity: (userIds, range) => get().userActivity(userIds, range),
	};
}
