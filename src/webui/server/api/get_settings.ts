import type { WebUIAPI } from "../types";

/**
 * 读取全部设置域
 *
 * GET
 * 返回每个域的 `{ id, define, values, setSecrets, restartFields, immutableFields }`。
 * `define` 可直接交给前端 config-editor 渲染, `values` 里的敏感字段已脱敏。
 *
 * 与 get_plugin_config 的分工: 那个面向"某个 Bot 的某个插件"、由插件自带 schema 驱动;
 * 这个面向框架自身的设置域 (WebUI / Core / 统计 ...), 由代码里的设置定义驱动。
 */
const api: WebUIAPI = {
	path: "get_settings",
	method: "GET",
	auth: true,

	handler(_req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		return {
			success: true,
			domains: core.settings.list().map((domain) => ({
				id: domain.id,
				...domain.read(),
			})),
		};
	},
};

export default api;
