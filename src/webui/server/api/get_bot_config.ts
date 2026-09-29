import type { WebUIAPI } from "../types";

/**
 * 读取某个 Bot 的设置
 *
 * POST
 * 请求体
 * - id: 目标 Bot id
 *
 * 返回形状与 get_settings 里的单个域一致 (define / values / ...), 前端可直接复用
 * 同一套渲染; 值里的敏感字段已脱敏。
 */
const api: WebUIAPI = {
	path: "get_bot_config",
	method: "POST",
	auth: true,

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const bot = core.bot.bots.get(`${req.body?.id ?? ""}`);
		if (!bot) throw { err: "目标Bot不存在", code: 404 };

		return { success: true, id: bot.id, ...bot.settings.read() };
	},
};

export default api;
