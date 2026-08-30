import { Bot } from "../../../bot/bot";
import type { WebUIAPI } from "../types";

/**
 * 设置Bot的插件状态
 * POST
 * 请求体
 * - bot: 目标bot id
 * - id: 目标插件 id
 * Future - global?: 是否为全局中的插件
 * - state: 状态, true or false
 */

export default {
	method: "POST",
	auth: true,
	path: "set_plugin_state",
	
	async handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 }
		let bot = req.body.bot;
		if (!core.bot.bots.has(bot)) throw { code: 404, err: "目标Bot不存在" };
		bot = core.bot.bots.get(bot)!;

		if (!(bot instanceof Bot)) throw { code: 418, err: "天呐!这几乎是不可能的, 你要知道这只是为了让ts进行类型收窄"};
		if (!bot.running) throw { code: 503, err: "目标Bot未启动" };

		let id = `${req.body.id}`;
		if (!!!bot.plugin.resolve(id)) throw { code: 404, err: "目标插件不存在" };

		
		let state = !!req.body.state; // 转布尔

		try {
			state ? await bot.plugin.load(id) : await bot.plugin.unload(id);
			// 运行成功后才持久化偏好; 失败时 state 不变, 不落盘
			bot.state.plugins[id] = state;
			await bot.saveState();
		} catch (e) {

			throw { code: 500, err: `更改插件状态失败: ${(e as Error).message}` }
		}

		return { success: true }


	},
} as WebUIAPI