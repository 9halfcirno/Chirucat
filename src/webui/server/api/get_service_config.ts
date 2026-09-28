import type { WebUIAPI } from "../types";

/**
 * 获取服务插件配置
 *
 * POST
 * 请求体
 * - id: 目标服务插件 id
 *
 * 返回配置定义(控件定义)与当前值, 供前端渲染配置表单。与 get_plugin_config
 * 同一套返回结构, 只是不按 Bot 隔离 —— 服务插件是全局单例, 值文件也全局唯一。
 */
export default {
	method: "POST",
	path: "get_service_config",
	auth: true,

	async handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const id = `${req.body?.id}`;
		const service = core.services.resolve(id);
		if (!service) throw { code: 404, err: `服务插件 ${id} 不存在` };

		if (!service.config) {
			// 服务卸载时会连带清掉配置, 这里重新装配一次(与插件版同理)
			await core.services.setupConfig(service);
			if (!service.config)
				throw { code: 404, err: `服务插件 ${id} 没有可用的配置` };
		}

		return {
			success: true,
			/** 控件定义, 前端用来渲染表单 */
			define: service.configSchema,
			/** 当前配置值 */
			config: service.config.data,
		};
	},
} as WebUIAPI;
