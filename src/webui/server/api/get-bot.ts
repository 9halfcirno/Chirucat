import type { WebUIAPI } from "../types";

const api: WebUIAPI = {
	path: "get_bot_list",
	method: "GET",
	auth: true,

	handler(core) {
		if (!core) return [];
		const bots = core.bot.bots;
		return {
			bots: bots.values().toArray().map(bot => {
				return {
					id: bot.id,
					state: bot.state
				}
			})
		}
	}
}

export default api;