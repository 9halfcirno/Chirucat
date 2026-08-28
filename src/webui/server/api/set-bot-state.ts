import type { WebUIAPI } from "../types";

/**
 * 设置Bot状态
 * POST
 * 请求体
 * - id: 目标bot id
 * - state: 状态, true or false
 */

export default {
	method: "POST",
	auth: true,
	path: "set_bot_state",
	
	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 }
		let id = `${req.body.id}`;
		if (!core.bot.bots.has(id)) throw { code: 404, err: "目标Bot不存在" };
		let state = !!req.body.state; // 转布尔

		try {
			state ? core.bot.start(id) : core.bot.stop(id);
		} catch (e) {

			throw { code: 500, err: `更改Bot状态失败: ${(e as Error).message}` }
		}

		return { success: true }


	},
} as WebUIAPI