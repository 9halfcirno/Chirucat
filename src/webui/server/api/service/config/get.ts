import type { WebUIAPI } from "../../../types";
import { fail, requireCore, requirePluginConfig } from "../../_shared";

/**
 * 获取服务插件配置
 *
 * POST
 * 请求体
 * - service: 目标服务插件 id
 *
 * 返回配置定义(控件定义)与当前值, 供前端渲染配置表单。与 bot/plugin/config/get
 * 同一套返回结构, 只是不按 Bot 隔离 —— 服务插件是全局单例, 值文件也全局唯一。
 */
const api: WebUIAPI = {
	method: "POST",
	auth: true,

	async handler(req, core) {
		const c = requireCore(core);

		const id = `${req.body?.service}`;
		const service = c.services.resolve(id);
		if (!service) fail(404, `服务插件 ${id} 不存在`);

		const { config, define } = await requirePluginConfig(
			service, "服务插件", (s) => c.services.setupConfig(s));

		return {
			success: true,
			/** 控件定义, 前端用来渲染表单 */
			define,
			/** 当前配置值 */
			config: config.values(),
		};
	},
}

export default api;
