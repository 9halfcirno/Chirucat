import type { WebUIAPI } from "../types";
import type { Core } from "../../../core";
import type { FilterEntry, FilterKind, FilterScope, FilterTargetType } from "../../../internal/filter-list";
import type { UserProfile } from "../../../internal/user-profile";

/**
 * 消息过滤名单 (黑/白名单)
 * POST
 * 请求体
 * - action: "list" | "add" | "remove"
 * - scope: "global"(全局) | "bot"(某个 Bot 私有)
 * - botId: scope=bot 时必填
 * - add 时另需:
 *   - kind: "black" | "white"
 *   - targetType: "user"(账号) | "session"(会话, 群 / 频道)
 *   - target: { platform, id, type? }  type 仅会话需要, 且只能是 group / channel
 *   - reason?
 * - remove 时另需: id
 * 返回
 * - list: { entries: [{ id, targetType, kind, target, platform, platformId, sessionType, name, reason, createdAt }] }
 * - add: { entry }
 * - remove: { removed: true }
 *
 * 用户名单以账号 UUID 为目标, 会话名单以会话 UUID 为目标 (与 MessageFilter 的
 * by: "sender" / "session" 对应)。私聊会话与用户一一对应, 因此不支持会话名单 ——
 * 私聊规则请用用户名单表达。
 *
 * 添加时用 (平台, 平台用户ID) 换取账号/会话 ID —— 此前没出现过也会建档,
 * 因此"提前拉黑还没发过言的人/还没出现过的群"成立。
 *
 * 变更后会立即刷新受影响的 Bot, 不需要重启。
 *
 * @deprecated 过滤能力将抽离为独立服务插件(services/filter), 届时这个 WebUI 端点
 *   与 `internal/filter-list.ts` 一起迁移; 过渡期只做修复性改动。
 */

const api: WebUIAPI = {
	path: "filter_list",
	method: "POST",
	auth: true,

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };
		if (!core.filterList) throw { err: "核心名单模块未就绪", code: 503 };
		if (!core.user) throw { err: "核心用户模块未就绪", code: 503 };

		const body = (req.body ?? {}) as {
			action?: unknown; scope?: unknown; botId?: unknown;
			kind?: unknown; targetType?: unknown; target?: unknown;
			reason?: unknown; id?: unknown;
		};

		const scope = parseScope(body.scope);
		const botId = parseBotId(core, scope, body.botId);

		if (body.action === "list") {
			return { entries: decorate(core, core.filterList.list(scope, botId)) };
		}

		if (body.action === "add") {
			const kind = parseKind(body.kind);
			const targetType = parseTargetType(body.targetType);
			const target = resolveTarget(core, targetType, body.target);
			const reason = typeof body.reason === "string" ? body.reason.trim() : "";

			const entry = core.filterList.add(scope, botId, kind, targetType, target, reason);

			refresh(core, scope, botId);
			return { entry: decorate(core, [entry])[0] };
		}

		if (body.action === "remove") {
			if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
				throw { code: 400, err: "id 必须是整数" };
			}

			const removed = core.filterList.remove(body.id);
			if (!removed) throw { code: 404, err: `名单项 ${body.id} 不存在` };
			// 被删项可能属于另一个范围, 按它自己的归属刷新
			refresh(core, removed.scope, removed.botId);

			return { removed: true };
		}

		throw { code: 400, err: "未知的 action" };
	},
};

/**
 * 把名单项补上平台信息与昵称 (按对象类型分组批量查询, 避免逐条查)
 */
function decorate(core: Core, entries: FilterEntry[]) {
	const userTargets = entries.filter(entry => entry.targetType === "user").map(entry => entry.target);
	const sessionTargets = entries.filter(entry => entry.targetType === "session").map(entry => entry.target);

	const users = core.user!.queryMany(userTargets);
	const profiles: Map<string, UserProfile> = core.profile?.getMany(userTargets) ?? new Map();
	const sessions = core.session?.queryMany(sessionTargets) ?? new Map();

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
function resolveTarget(core: Core, targetType: FilterTargetType, value: unknown): string {
	const { platform, id } = parseTarget(value);

	if (targetType === "session") {
		const type = parseSessionType((value as { type?: unknown } | null)?.type);
		if (!core.session) throw { err: "核心会话模块未就绪", code: 503 };
		return core.session.get(platform, type, id);
	}

	// get() 是 get-or-create: 名单可以先于对方的首次发言建立
	return core.user!.get(platform, id);
}

/** 名单变更后刷新受影响的 Bot */
function refresh(core: Core, scope: FilterScope, botId: string): void {
	if (scope === "global") {
		// 全局名单对所有 Bot 生效
		for (const bot of core.bot.bots.values()) bot.message.loadFilterList();
		return;
	}
	core.bot.bots.get(botId)?.message.loadFilterList();
}

function parseScope(value: unknown): FilterScope {
	if (value === "global" || value === "bot") return value;
	throw { code: 400, err: 'scope 必须是 "global" 或 "bot"' };
}

/** 校验 scope=bot 时给出的 Bot; 全局范围一律忽略 botId */
function parseBotId(core: Core, scope: FilterScope, value: unknown): string {
	if (scope === "global") return "";

	if (typeof value !== "string" || !value.trim()) {
		throw { code: 400, err: "scope=bot 时必须提供 botId" };
	}
	const botId = value.trim();
	if (!core.bot.bots.has(botId)) {
		throw { code: 404, err: `Bot ${botId} 不存在` };
	}
	return botId;
}

function parseKind(value: unknown): FilterKind {
	if (value === "black" || value === "white") return value;
	throw { code: 400, err: 'kind 必须是 "black" 或 "white"' };
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

export default api;
