import type { WebUIAPI } from "../types";

const api: WebUIAPI = {
	path: "get_webui_front_config",
	method: "GET",
	auth: true,

	async handler(_, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 }
		
		return core.webui!.front || {};
	}
}

export default api;