import type { WebUIAPI } from "../../../types";
import { fail, requireBot, requireCore } from "../../_shared";

/**
 * 读取某个 Bot 的设置
 *
 * POST
 * 请求体
 * - bot: 目标 Bot id
 *
 * 返回形状与 settings/get 里的单个域一致 (define / values / ...), 前端可直接复用
 * 同一套渲染; 值里的敏感字段已脱敏。
 */
const api: WebUIAPI = {
	method: "POST",
	auth: true,

	handler(req, core) {
		const bot = requireBot(requireCore(core), `${req.body?.bot ?? ""}`);

		return { success: true, id: bot.id, ...bot.settings.read() };
	},
};

export default api;
