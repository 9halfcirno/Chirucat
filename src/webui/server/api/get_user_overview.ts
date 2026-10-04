import type { WebUIAPI } from "../types";
import { clampInt, requireCore, requireUser } from "./_shared";

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
		const c = requireCore(core);
		const user = requireUser(c);

		const body = (req.body ?? {}) as { days?: unknown };
		const days = clampInt(body.days, 7, 1, 30);

		const to = Date.now();
		const summary = c.statistics?.summary({ from: to - days * DAY_MS, to }) ?? null;

		return {
			...user.overview(),
			days,
			activeAccounts: summary ? summary.users : 0,
			statisticsEnabled: c.statistics !== null,
			partial: summary ? summary.partial : false,
		};
	},
};

export default api;
