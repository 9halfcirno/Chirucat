import type { WebUIAPI } from "../types";
import { fail, requireBot, requireCore, savePluginConfig } from "./_shared";

/**
 * 更新插件配置
 *
 * POST
 * 请求体
 * - bot: 目标bot id
 * - id: 目标插件 id
 * - config: 配置值 (前端 config-editor 的 getValues() 输出)
 *
 * 保存时以插件的配置定义(manifest.config)为骨架合并:
 * 提交里缺失的已知键保留旧值 —— 前端不产出隐藏项, 直接覆盖会把隐藏项抹掉。
 */
export default {
	method: "POST",
	path: "update_plugin_config",
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
					? `Bot ${bot.id} 尚未扫描插件(需先启动一次), 无法更新插件配置`
					: `插件 ${id} 不存在`,
			);
		}
		if (!plugin.config) fail(404, `插件 ${id} 没有可用的配置`);

		return savePluginConfig(plugin.config, req.body?.config, `插件 ${id}`);
	},
} as WebUIAPI;
