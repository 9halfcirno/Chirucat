import type { WebUIAPI } from "../types";
import { fail, requireRunningBot, requireCore } from "./_shared";

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
		const bot = requireRunningBot(requireCore(core), `${req.body.bot}`);

		const id = `${req.body.id}`;
		if (!bot.plugin.resolve(id)) fail(404, `目标插件不存在: ${id}`);

		const state = !!req.body.state; // 转布尔

		try {
			// setPluginEnabled 先加载/卸载, 成功后才把偏好写入 state.json
			await bot.setPluginEnabled(id, state);
		} catch (e) {
			fail(500, `更改插件状态失败: ${(e as Error).message}`);
		}

		// 回传收敛后的运行态: 与 set_bot_state 一致, 前端据此对齐开关
		return { success: true, state: bot.plugin.resolve(id)?.status === "enabled" }
	},
} as WebUIAPI;
