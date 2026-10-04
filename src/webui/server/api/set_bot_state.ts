import type { WebUIAPI } from "../types";
import { fail, requireBot, requireCore } from "./_shared";

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

	async handler(req, core) {
		const bot = requireBot(requireCore(core), `${req.body.id}`);
		const state = !!req.body.state; // 转布尔

		try {
			// setEnable 先收敛运行态, 成功后才把偏好写入 state.json
			await bot.setEnable(state);
		} catch (e) {
			fail(500, `更改Bot状态失败: ${(e as Error).message}`);
		}

		return { success: true, state: bot.running }
	},
} as WebUIAPI;
