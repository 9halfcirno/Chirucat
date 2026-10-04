import type { WebUIAPI } from "../types";
import { requireCore } from "./_shared";

const api: WebUIAPI = {
	path: "get_webui_front_config",
	method: "GET",
	auth: true,

	async handler(_, core) {
		const c = requireCore(core);

		return c.webui?.front ?? {};
	}
}

export default api;