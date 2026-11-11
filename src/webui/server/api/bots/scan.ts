import path from "path";
import { root } from "../../../../utils/root";
import type { WebUIAPI } from "../../types";
import { requireCore } from "../_shared";

/**
 * 重扫 bots 目录, 返回最新的 Bot 列表
 */
const api: WebUIAPI = {
	method: "POST",
	auth: true,

	async handler(_, core) {
		let c = requireCore(core);

		await c.bot.scan(path.join(root, "bots"));

		const bots = c.bot.bots;
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