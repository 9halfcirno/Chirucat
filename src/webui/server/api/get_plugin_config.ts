import type { WebUIAPI } from "../types";
import { fail, requireBot, requireCore } from "./_shared";

/**
 * 获取插件配置
 *
 * POST
 * 请求体
 * - bot: 目标bot id
 * - id: 目标插件 id
 *
 * 返回配置定义(控件定义)与当前值, 供前端渲染配置表单。
 */
export default {
	method: "POST",
	path: "get_plugin_config",
	auth: true,

	async handler(req, core) {
		const bot = requireBot(requireCore(core), `${req.body?.bot ?? ""}`);

		const id = `${req.body?.id}`;
		const plugin = bot.plugin.resolve(id);
		if (!plugin) {
			// 未启动过的 Bot 从未扫描插件, 报"插件不存在"会误导
			const scanned = bot.plugin.globalPlugins.size + bot.plugin.botPlugins.size;
			fail(
				404,
				scanned === 0
					? `Bot ${bot.id} 尚未扫描插件(需先启动一次), 无法读取插件配置`
					: `插件 ${id} 不存在`,
			);
		}
		if (!plugin.config) {
			// 如果没有配置, 可能是插件卸载导致的清理, 尝试重新装配一次
			await bot.plugin.setupConfig(plugin);
			if (!plugin.config) // 如果还没有就报错
				fail(404, `插件 ${id} 没有可用的配置`);
		};

		return {
			success: true,
			/** 控件定义, 前端用来渲染表单 */
			define: plugin.configSchema,
			/** 当前配置值 */
			config: plugin.config.data,
		};
	},
} as WebUIAPI;
