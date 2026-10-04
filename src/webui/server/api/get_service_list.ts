import type { WebUIAPI } from "../types";
import { requireCore } from "./_shared";
import { buildServicePayload } from "../service-view";

/**
 * 获取服务插件列表 (只读, 不扫描目录)
 *
 * POST (无需请求体)
 *
 * 返回结构与 refresh_services 一致, 但不扫描 services/ 目录。
 */
export default {
	method: "POST",
	path: "get_service_list",
	auth: true,

	handler(_req, core) {
		const c = requireCore(core);

		return buildServicePayload(c.services);
	},
} as WebUIAPI;
