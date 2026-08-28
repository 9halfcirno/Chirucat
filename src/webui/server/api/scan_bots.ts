import path from "path";
import type { WebUIAPI } from "../types";
import { root } from "../../../utils/root";

const api: WebUIAPI = {
	path: "scan_bots",
	method: "GET",
	auth: true,

	async handler(_, core) {
		if (!core) return [];

		await core.bot.scan(path.join(root, "bots"));

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