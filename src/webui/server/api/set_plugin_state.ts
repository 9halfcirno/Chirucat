import type { WebUIAPI } from "../types";
import { changedPluginIds, fail, requireRunningBot, requireCore, snapshotEnabledPlugins } from "./_shared";

/**
 * 设置Bot的插件状态
 * POST
 * 请求体
 * - bot: 目标bot id
 * - id: 目标插件 id
 * Future - global?: 是否为全局中的插件
 * - state: 状态, true or false
 *
 * 返回收敛后的运行态, 以及依赖连带导致状态变化的插件 id(`affected`)。
 * 启用会连带拉起它依赖的插件, 停用会连带卸载依赖它的插件 —— 前端据此
 * 逐个对齐那些卡片的开关, 不必重新扫描目录或重绘整页。
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

		const before = snapshotEnabledPlugins(bot.plugin);
		try {
			// setPluginEnabled 先加载/卸载(含依赖连带), 成功后才把偏好写入 state.json
			await bot.setPluginEnabled(id, state);
		} catch (e) {
			fail(500, `更改插件状态失败: ${(e as Error).message}`);
		}

		return {
			success: true,
			// 回传收敛后的运行态: 与 set_bot_state 一致, 前端据此对齐开关
			state: bot.plugin.resolve(id)?.status === "enabled",
			/** 本次被依赖连带改变的插件 id; 前端按 data.state 逐个对齐 */
			affected: changedPluginIds(before, snapshotEnabledPlugins(bot.plugin), id),
		};
	},
} as WebUIAPI;
