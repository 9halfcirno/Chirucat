import type { WebUIAPI } from "../../types";
import { fail, requireCore } from "../_shared";

const api: WebUIAPI = {
	method: "POST",
	auth: true,

	async handler(req, core) {
		const c = requireCore(core);

		const body = (req.body ?? {}) as { bot?: unknown; };
		const { bot } = body;

		if (typeof bot !== "string") fail(400, "bot字段无效");

		if (!c.bot.bots.has(bot)) {
			fail(404, `Bot ${bot} 不存在`);
		}

		try {
			await c.botHelper.delete(bot);
			// Bot 已删除, 它名下的私有名单不再有意义: 名单服务(chirucat-filter)在运行时顺手清掉。
			// 服务未启用/未导出时不动它, 也不阻断删除 —— 残留的行是惰性的(该 botId 已不存在,
			// 判定不会命中), 只有重建同名 Bot 才谈得上影响。
			try {
				const filter = c.services.exports.getExports("chirucat-filter") as
					| { removeByBot?: (botId: string) => number }
					| undefined;
				filter?.removeByBot?.(bot);
			} catch (e) {
				c.services.logger.warn(`清理 Bot ${bot} 的私有名单失败: ${e instanceof Error ? e.message : e}`);
			}
			return { success: true };
		} catch (e) {
			fail(500, `删除Bot失败: ${(e as Error).message}`);
		}
	},
};

export default api;
