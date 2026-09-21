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
					// running 是运行态, state 是期望态: 前端开关要用期望态,
					// 而"是否正在运行"必须看 running
					running: bot.running,
					// 必须是普通快照: 直接返回 BotStateManager 会把它的内部字段
					// (file / watcher / writing ...) 一并序列化给前端
					state: bot.state.get()
				}
			})
		}
	}
}

export default api;