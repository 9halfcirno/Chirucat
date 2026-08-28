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
					state: bot.state
				}
			})
		}
	}
}

export default api;