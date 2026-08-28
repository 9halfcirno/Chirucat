import { Bot } from "../../../bot/bot";
import type { WebUIAPI } from "../types";

/**
 * 获取插件列表
 * POST
 * 请求体
 * - bot?: 目标bot id, FUTURE: 不填就返回全局
 */

export default {
	method: "POST",
	path: "get_plugin_list",
	auth: true,

	handler(req, core) {
		if (!core) return {
			plugins: { global: [], bot: [] }
		}

		let bot = req.body.bot;
		if (typeof bot === "string") {
			if (!core.bot.bots.has(bot)) throw { code: 404, err: "找不到目标Bot" }
			bot = core.bot.bots.get(bot);
			if (!(bot instanceof Bot)) throw { code: 418, err: "天呐!这几乎使不可能的, 你要知道这只是为了让ts进行类型收窄"};
			return {
				plugins: {
					global: bot.plugin.globalPlugins.values().map(p => p.manifest).toArray(),
					bot: bot.plugin.botPlugins.values().map(p => p.manifest).toArray()
				}
			}
		} else {
			throw { code: 404, err: "当前请求体必须包含bot字段" }
		}
	}
} as WebUIAPI