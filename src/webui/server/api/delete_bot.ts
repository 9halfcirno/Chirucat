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
			return { success: true };
		} catch (e) {
			throw { code: 500, err: `创建Bot失败: ${(e as Error).message}` };
		}
	},
};

export default api;
