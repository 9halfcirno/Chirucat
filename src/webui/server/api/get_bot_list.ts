import type { WebUIAPI } from "../types";

const api: WebUIAPI = {
	path: "get_bot_list",
	method: "GET",
	auth: true,

	handler(_, core) {
		if (!core) return [];
		const bots = core.bot.bots;
		return {
			bots: bots.values().toArray().map(bot => {
				return {
					id: bot.id,
					name: bot.name,
					// 运行态与期望态分开返回, 与 get_bot_state 保持一致
					running: bot.running,
					state: bot.state.get()
				}
			})
		}
	}
}

export default api;