import type { WebUIAPI } from "../types";

const api: WebUIAPI = {
	path: "delete_bot",
	method: "POST",
	auth: true,

	async handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const body = (req.body ?? {}) as { id?: unknown; };
		const { id } = body;

		if (typeof id !== "string") throw { code: 400, err: "id字段无效" }

		if (!core.bot.bots.has(id)) {
			throw { code: 409, err: `Bot ${id} 不存在` };
		}

		try {
			await core.botHelper.delete(id);
			// Bot 已删除, 它名下的私有名单不再有意义: 名单服务(chirucat-filter)在运行时顺手清掉。
			// 服务未启用/未导出时不动它, 也不阻断删除 —— 残留的行是惰性的(该 botId 已不存在,
			// 判定不会命中), 只有重建同名 Bot 才谈得上影响。
			try {
				const filter = core.services.exports.getExports("chirucat-filter") as
					| { removeByBot?: (botId: string) => number }
					| undefined;
				filter?.removeByBot?.(id);
			} catch (e) {
				core.services.logger.warn(`清理 Bot ${id} 的私有名单失败: ${e instanceof Error ? e.message : e}`);
			}
			return { success: true };
		} catch (e) {
			throw { code: 500, err: `创建Bot失败: ${(e as Error).message}` };
		}
	},
};

export default api;
