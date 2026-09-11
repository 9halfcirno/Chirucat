import type { WebUIAPI } from "../types";

/** 与 statistics/types.ts 中的 StatRange 结构一致。此处刻意不 import, 以便 statistics 目录被删除时本文件仍可加载 */
type Range = { from: number; to: number; botId?: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 缺省查询范围为最近 24 小时 */
function resolveRange(body: Body): Range {
	const to = typeof body.to === "number" ? body.to : Date.now();
	const from = typeof body.from === "number" ? body.from : to - DAY_MS;

	const range: Range = { from: from < to ? from : to, to };
	if (typeof body.botId === "string" && body.botId) range.botId = body.botId;
	return range;
}

export default {
	path: "get_stats",

	auth: true,
	method: "POST",

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 }

		// 统计是可选功能, 未启用时 core.statistics 为 null
		const stats = core.statistics;
		if (!stats) throw { err: "统计功能未启用", code: 503 }

		const body = req.body as Body;

		if (body.target === "bots") {
			return { bots: stats.bots() };
		}

		const range = resolveRange(body);

		if (body.target === "summary") {
			return { summary: stats.summary(range) };
		}

		if (body.target === "timeline") {
			const bucketMs = typeof body.bucketMs === "number" && body.bucketMs > 0 ? body.bucketMs : HOUR_MS;
			return { timeline: stats.timeline(range, bucketMs) };
		}

		if (body.target === "rank") {
			const by = body.by === "platform" ? "platform" : "session";
			const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 10;
			return { by, rank: stats.rank(range, by, limit) };
		}

		throw { err: "未知的统计查询类型", code: 400 }
	},
} as WebUIAPI

type Body = {
	target: "summary" | "timeline" | "rank" | "bots";
	/** 起始时间(ms, 含) */
	from?: number;
	/** 结束时间(ms, 不含) */
	to?: number;
	/** 限定 Bot id */
	botId?: string;
	/** 时间线分桶粒度(ms) */
	bucketMs?: number;
	/** 排行维度 */
	by?: "session" | "platform";
	/** 排行条数 */
	limit?: number;
}
