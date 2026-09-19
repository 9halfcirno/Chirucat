import type { WebUIAPI } from "../types";

const api: WebUIAPI = {
	path: "get_bot_state",
	method: "POST",
	auth: true,

	handler(req, core) {
		if (!core) return {};

		const id = req.body?.id;
		if (!id) {
			throw { code: 404, err: "未传入bot id" };
		}

		const bot = core.bot.bots.get(id);
		if (!bot) {
			throw { code: 404, err: "目标Bot不存在" };;
		}

		return {
			id: bot.id,
			name: bot.name,
			state: bot.state
		};
	}
}

export default api;