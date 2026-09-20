import type { WebUIAPI } from "../types";

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
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const bot = core.bot.bots.get(req.body?.bot);
		if (!bot) throw { code: 404, err: "目标Bot不存在" };

		const id = `${req.body?.id}`;
		const plugin = bot.plugin.resolve(id);
		if (!plugin) {
			// 未启动过的 Bot 从未扫描插件, 报"插件不存在"会误导
			const scanned = bot.plugin.globalPlugins.size + bot.plugin.botPlugins.size;
			throw {
				code: 404,
				err: scanned === 0
					? `Bot ${bot.id} 尚未扫描插件(需先启动一次), 无法更新插件配置`
					: `插件 ${id} 不存在`,
			};
		}
		if (!plugin.config) throw { code: 404, err: `插件 ${id} 没有可用的配置` };

		const config = plugin.config;

		// 校验不通过不落盘; details 带上字段级错误, 供前端定位到具体控件
		const errors = config.vaildate(req.body?.config);
		if (errors.length) {
			const detail = errors
				.map(e => `${e.path || "配置"}: ${e.message}`)
				.join("; ");
			throw { code: 400, err: `配置校验未通过: ${detail}`, details: errors };
		}

		try {
			await config.update(req.body?.config);
		} catch (e) {
			throw { code: 500, err: `保存插件配置失败: ${(e as Error).message}` };
		}

		// 回传规范化后的值: 隐藏项、缺失键已被补齐, 便于前端与后端对齐
		return { success: true, config: config.data };
	},
} as WebUIAPI;
