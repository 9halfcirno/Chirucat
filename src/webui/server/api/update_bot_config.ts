import type { WebUIAPI } from "../types";

export default {
	path: "update_bot_config",

	method: "POST",
	handler(req, core) {
		if (!core) throw { code: 503, err: "WebUI后端未连接核心" }
	},
} as WebUIAPI