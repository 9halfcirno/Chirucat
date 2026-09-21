import type { WebUIAPI } from "../types";
import { buildPluginPayload } from "../plugin-view";

/**
 * 获取插件列表 (只读, 不扫描插件目录)
 *
 * POST
 * 请求体
 * - bot: 目标bot id
 *
 * 返回结构与 refresh_plugins 完全一致, 但不会扫描目录: 未扫描过的 Bot
 * (从未启动、也没刷新过)会得到空列表, 前端首屏因此统一用 refresh_plugins。
 */
export default {
	method: "POST",
	path: "get_plugin_list",
	auth: true,

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const bot = core.bot.bots.get(req.body?.bot);
		if (!bot) throw { code: 404, err: "目标Bot不存在" };

		return buildPluginPayload(bot);
	},
} as WebUIAPI;
