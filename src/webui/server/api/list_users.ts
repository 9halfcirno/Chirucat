import type { WebUIAPI } from "../types";
import { clampInt, requireCore, requireUser } from "./_shared";
import type { UserListQuery } from "../../../internal/user-manager";
import type { UserProfile } from "../../../internal/user-profile";
import type { UserActivity } from "../../../statistics/types";

/**
 * 用户列表 (分页)
 * POST
 * 请求体
 * - platform?: 平台筛选
 * - keyword?: 匹配平台用户ID 或 账号ID
 * - bound?: "all"(默认) / "bound"(组内多于一个) / "single"(独立成组)
 * - limit?: 每页条数 (默认 20, 上限 100)
 * - offset?: 偏移量 (默认 0)
 * - days?: 活跃统计回看天数 (默认 7, 上限 30)
 * 返回
 * - total: 命中总数
 * - statisticsEnabled: 统计模块是否可用 (为 false 时 activity 全为 null)
 * - items: [{ accountId, platform, id, unionId, unionSize, name, avatar, activity }]
 *
 * 分页由内部库完成, 昵称与活跃度只对当前页的账号批量补齐 ——
 * 内部库与统计库是两个独立的 sqlite 文件, 无法联表, 必须"先分页再聚合"。
 * activity 仅覆盖明细保留期内的数据 (默认 7 天), 更早的明细已聚合掉用户维度。
 */

const DAY_MS = 86_400_000;

const api: WebUIAPI = {
	path: "list_users",
	method: "POST",
	auth: true,

	handler(req, core) {
		const c = requireCore(core);
		const user = requireUser(c);

		const body = (req.body ?? {}) as {
			platform?: unknown; keyword?: unknown; bound?: unknown;
			limit?: unknown; offset?: unknown; days?: unknown;
		};

		const limit = clampInt(body.limit, 20, 1, 100);
		const offset = clampInt(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
		const days = clampInt(body.days, 7, 1, 30);

		const query: UserListQuery = { limit, offset };
		if (typeof body.platform === "string" && body.platform.trim()) query.platform = body.platform.trim();
		if (typeof body.keyword === "string" && body.keyword.trim()) query.keyword = body.keyword.trim();
		if (body.bound === "bound" || body.bound === "single") query.bound = body.bound;

		const { items, total } = user.list(query);
		const ids = items.map(item => item.accountId);

		const profiles: Map<string, UserProfile> = c.profile?.getMany(ids) ?? new Map();
		const activity: Map<string, UserActivity> = c.statistics
			? c.statistics.userActivity(ids, { from: Date.now() - days * DAY_MS, to: Date.now() })
			: new Map();

		return {
			total,
			limit,
			offset,
			days,
			statisticsEnabled: c.statistics !== null,
			items: items.map(item => {
				const profile = profiles.get(item.accountId);
				return {
					...item,
					name: profile?.name ?? "",
					avatar: profile?.avatar ?? "",
					activity: activity.get(item.accountId) ?? null,
				};
			}),
		};
	},
};

export default api;
