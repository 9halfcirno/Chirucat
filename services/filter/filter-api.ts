import type { SessionType } from "../../src/protocols/session";
import type { FilterManager } from "./filter-manager";
import type { FilterEntry, FilterKind, FilterMode, FilterScope, FilterTargetType } from "./types";

/**
 * WebUI 管理端点: `/service/chirucat-filter/api/filter_list`
 *
 * 名称沿用迁移前的核心端点, 形状也基本一致, 差别只在实现位置(名单存储、判定与端点
 * 都归本插件)以及新增的**判定模式**:
 *
 * 请求体
 * - action: "list" | "add" | "remove" | "setMode"
 * - scope: "global"(全局) | "bot"(某个 Bot 私有)
 * - botId: scope=bot 时必填
 * - add 时另需:
 *   - kind: "black" | "white"
 *   - targetType: "user"(账号) | "session"(会话, 群 / 频道)
 *   - target: { platform, id, type? }  type 仅会话需要, 且只能是 group / channel
 *   - reason?
 * - remove 时另需: id
 * - setMode 时另需: mode: "all" | "black" | "white"
 * 返回
 * - list: { entries: [...], mode } —— mode 是该**范围**当前的判定模式
 * - add: { entry }
 * - remove: { removed: true }
 * - setMode: { mode }
 *
 * 用户名单以账号 UUID 为目标, 会话名单以会话 UUID 为目标。私聊会话与用户一一对应,
 * 因此不支持会话名单 —— 私聊规则请用用户名单表达。
 *
 * 添加时用 (平台, 平台用户ID) 换取账号/会话 ID —— 此前没出现过也会建档, 因此
 * "提前拉黑还没发过言的人/还没出现过的群"成立。
 *
 * 改动**立即生效**: 名单/模式落在本插件的库与内存判定层里, 不需要通知任何 Bot 重新装载。
 */

/** 端点用到的框架设施视图(由 `ctx.core` 提供, 每次请求重新取) */
export type FilterCoreViews = {
	user: {
		/** 取或建: 平台账号 -> 账号 UUID */
		get(platform: string, id: string): string;
		queryMany(ids: string[]): Map<string, { id: string; platform: string }>;
	};
	session: {
		/** 取或建: 平台会话 -> 会话 UUID */
		get(platform: string, type: SessionType, id: string): string;
		queryMany(ids: string[]): Map<string, { id: string; platform: string; type: string }>;
	};
	profile: {
		getMany(ids: string[]): Map<string, { name: string }>;
	};
	bot: {
		has(id: string): boolean;
	};
};

export type FilterRouteDeps = {
	/** 名单门面: 存储 + 判定, 改动会同步两份 */
	manager: FilterManager;
	/**
	 * 框架设施视图
	 *
	 * 声明成 getter: 每次请求都取一次 —— 视图本身是廉价代理, 缓存下来只会拿到
	 * Core 释放之后的旧东西(与 `ctx.core` 的约定一致)。
	 */
	readonly core: FilterCoreViews;
};

/**
 * 构造 filter_list 端点的处理器
 * @param deps 依赖
 * @returns 处理器: 入参为已解析的 JSON 请求体
 */
export function createFilterHandler(deps: FilterRouteDeps) {
	return {
		handle(body: unknown) {
			const core = deps.core;
			const request = (body ?? {}) as {
				action?: unknown; scope?: unknown; botId?: unknown;
				kind?: unknown; targetType?: unknown; target?: unknown;
				reason?: unknown; id?: unknown; mode?: unknown;
			};

			const scope = parseScope(request.scope);
			const botId = parseBotId(core, scope, request.botId);

			if (request.action === "list") {
				return {
					entries: decorate(core, deps.manager.list(scope, botId)),
					mode: deps.manager.mode(scope, botId),
				};
			}

			if (request.action === "setMode") {
				const mode = parseMode(request.mode);
				return { mode: deps.manager.setMode(scope, botId, mode) };
			}

			if (request.action === "add") {
				const kind = parseKind(request.kind);
				const targetType = parseTargetType(request.targetType);
				const target = resolveTarget(core, targetType, request.target);
				const reason = typeof request.reason === "string" ? request.reason.trim() : "";

				const entry = deps.manager.add(scope, botId, kind, targetType, target, reason);
				return { entry: decorate(core, [entry])[0] };
			}

			if (request.action === "remove") {
				if (typeof request.id !== "number" || !Number.isInteger(request.id)) {
					throw { code: 400, err: "id 必须是整数" };
				}

				const removed = deps.manager.remove(request.id);
				if (!removed) throw { code: 404, err: `名单项 ${request.id} 不存在` };

				return { removed: true };
			}

			throw { code: 400, err: "未知的 action" };
		},
	};
}

/**
 * 把名单项补上平台信息与昵称 (按对象类型分组批量查询, 避免逐条查)
 */
function decorate(core: FilterCoreViews, entries: FilterEntry[]) {
	const userTargets = entries.filter(entry => entry.targetType === "user").map(entry => entry.target);
	const sessionTargets = entries.filter(entry => entry.targetType === "session").map(entry => entry.target);

	const users = core.user.queryMany(userTargets);
	const profiles = core.profile.getMany(userTargets);
	const sessions = core.session.queryMany(sessionTargets);

	return entries.map(entry => {
		const isSession = entry.targetType === "session";
		const info = isSession ? sessions.get(entry.target) : users.get(entry.target);

		return {
			id: entry.id,
			scope: entry.scope,
			botId: entry.botId,
			targetType: entry.targetType,
			kind: entry.kind,
			target: entry.target,
			platform: info?.platform ?? "",
			platformId: info?.id ?? "",
			sessionType: isSession && info ? (info as { type: string }).type : "",
			name: isSession ? "" : (profiles.get(entry.target)?.name ?? ""),
			reason: entry.reason,
			createdAt: entry.createdAt,
		};
	});
}

/** 把 (平台, 平台ID) 换成框架内部的账号 / 会话 ID */
function resolveTarget(core: FilterCoreViews, targetType: FilterTargetType, value: unknown): string {
	const { platform, id } = parseTarget(value);

	if (targetType === "session") {
		const type = parseSessionType((value as { type?: unknown } | null)?.type);
		return core.session.get(platform, type, id);
	}

	// get() 是 get-or-create: 名单可以先于对方的首次发言建立
	return core.user.get(platform, id);
}

function parseScope(value: unknown): FilterScope {
	if (value === "global" || value === "bot") return value;
	throw { code: 400, err: 'scope 必须是 "global" 或 "bot"' };
}

/** 校验 scope=bot 时给出的 Bot; 全局范围一律忽略 botId */
function parseBotId(core: FilterCoreViews, scope: FilterScope, value: unknown): string {
	if (scope === "global") return "";

	if (typeof value !== "string" || !value.trim()) {
		throw { code: 400, err: "scope=bot 时必须提供 botId" };
	}
	const botId = value.trim();
	if (!core.bot.has(botId)) {
		throw { code: 404, err: `Bot ${botId} 不存在` };
	}
	return botId;
}

function parseKind(value: unknown): FilterKind {
	if (value === "black" || value === "white") return value;
	throw { code: 400, err: 'kind 必须是 "black" 或 "white"' };
}

function parseMode(value: unknown): FilterMode {
	if (value === "all" || value === "black" || value === "white") return value;
	throw { code: 400, err: 'mode 必须是 "all" / "black" / "white"' };
}

function parseTargetType(value: unknown): FilterTargetType {
	if (value === "user" || value === "session") return value;
	throw { code: 400, err: 'targetType 必须是 "user" 或 "session"' };
}

/** 会话名单只覆盖群与频道: 私聊与用户一一对应, 由用户名单表达 */
function parseSessionType(value: unknown): "group" | "channel" {
	if (value === "group" || value === "channel") return value;
	throw { code: 400, err: 'target.type 必须是 "group" 或 "channel" (私聊请使用用户名单)' };
}

function parseTarget(value: unknown): { platform: string; id: string } {
	const { platform, id } = (value ?? {}) as { platform?: unknown; id?: unknown };
	if (typeof platform !== "string" || !platform.trim()) {
		throw { code: 400, err: "target.platform 必须是非空字符串" };
	}
	if (typeof id !== "string" || !id.trim()) {
		throw { code: 400, err: "target.id 必须是非空字符串" };
	}
	return { platform: platform.trim(), id: id.trim() };
}
