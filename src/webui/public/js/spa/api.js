/**
 * WebUI 接口调用封装
 *
 * 统一带上同源 Cookie 并提取错误信息; 401 由 auth.js 的全局回调处理。
 */
import { apiFetch } from "./auth.js";

/**
 * 发起一次请求并解析响应
 *
 * @param {string} url 同源路径 (含前缀)
 * @param {object} [payload] 请求体 (method 为 GET 时忽略)
 * @param {"POST" | "GET"} [method] 请求方法
 * @returns {Promise<any>} 解析后的响应体
 */
async function request(url, payload, method) {
	const options = { method };
	if (method !== "GET") {
		options.headers = { "Content-Type": "application/json" };
		options.body = JSON.stringify(payload ?? {});
	}

	const res = await apiFetch(url, options);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.err || `HTTP ${res.status}`);
	return data;
}

/**
 * 调用 WebUI 接口
 *
 * @param {string} path 接口名 (不含 /api/ 前缀)
 * @param {object} [payload] 请求体 (method 为 GET 时忽略)
 * @param {"POST" | "GET"} [method="POST"] 请求方法
 * @returns {Promise<any>} 解析后的响应体
 */
export async function callAPI(path, payload, method = "POST") {
	return request(`/api/${path}`, payload, method);
}

/**
 * 调用服务插件注册的接口
 *
 * 服务插件的端点落在它自己的命名空间里: `/service/<serviceId>/api/<path>`;
 * 它自带的静态资源在同级的 `/service/<serviceId>/public` 下。服务未启用时返回 503,
 * 这里会照常把原因抛给调用方展示。
 *
 * @param {string} serviceId 服务插件 id (清单里的 id)
 * @param {string} path 接口名 (不含 /service/<id>/api/ 前缀)
 * @param {object} [payload] 请求体 (method 为 GET 时忽略)
 * @param {"POST" | "GET"} [method="POST"] 请求方法
 * @returns {Promise<any>} 解析后的响应体
 */
export async function callServiceAPI(serviceId, path, payload, method = "POST") {
	return request(`/service/${serviceId}/api/${path}`, payload, method);
}
