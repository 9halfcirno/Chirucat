import type { WebUIAPI } from "../../types";
import { requireCore } from "../_shared";

/**
 * 获取 Bot 列表, 不进行重扫
 */
export default {
	method: "GET",
	auth: true,
	handler(req, core) {
		let c = requireCore(core);

		let bots = c.bot.bots;
		return {
			bots: bots.values().toArray().map(bot => {
				return {
					id: bot.id,
					name: bot.name,
					running: bot.running,
					state: bot.state.get()
				}
			})
		}
	},
} as WebUIAPI