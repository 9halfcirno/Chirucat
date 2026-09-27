import type { WebUIAPI } from "../types";

/**
 * 用户概览: 账号与跨平台ID 的规模统计
 * POST
 * 请求体
 * - days?: 活跃统计回看天数 (默认 7, 上限 30)
 * 返回
 * - accounts / unions / boundUnions / singleAccounts / platforms: 来自内部库
 * - activeAccounts: 近 N 天活跃账号数 (去重, 仅明细期)
 * - statisticsEnabled: 统计模块是否可用
 * - partial: 统计模块可用且范围跨越明细保留期时为 true, 此时活跃账号数不完整
 */

const DAY_MS = 86_400_000;

const api: WebUIAPI = {
	path: "get_user_overview",
	method: "POST",
	auth: true,

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };
		if (!core.user) throw { err: "核心用户模块未就绪", code: 503 };

		const body = (req.body ?? {}) as { days?: unknown };
		const days = clampInt(body.days, 7, 1, 30);

		const to = Date.now();
		const summary = core.statistics?.summary({ from: to - days * DAY_MS, to }) ?? null;

		return {
			...core.user.overview(),
			days,
			activeAccounts: summary ? summary.users : 0,
			statisticsEnabled: core.statistics !== null,
			partial: summary ? summary.partial : false,
		};
	},
};

/** 取整数并夹在 [min, max] 内; 非数字时用默认值 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

export default api;
