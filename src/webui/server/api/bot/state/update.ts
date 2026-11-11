import type { WebUIAPI } from "../../../types";
import { requireBot, requireCore, fail } from "../../_shared";

/**
 * 设置Bot状态
 * POST
 * 请求体
 * - bot: 目标bot id
 * - state: 状态, true or false
 */

const api: WebUIAPI = {
	method: "POST",
	auth: true,

	async handler(req, core) {
		const bot = requireBot(requireCore(core), `${req.body.bot}`);
		const state = !!req.body.state; // 转布尔

		try {
			// setEnable 先收敛运行态, 成功后才把偏好写入 state.json
			await bot.setEnable(state);
		} catch (e) {
			fail(500, `更改Bot状态失败: ${(e as Error).message}`);
		}

		return { success: true, state: bot.running }
	},
}

export default api;
