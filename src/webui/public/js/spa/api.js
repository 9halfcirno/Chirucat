/**
 * WebUI 接口调用封装
 *
 * 统一带上同源 Cookie 并提取错误信息; 401 由 auth.js 的全局回调处理。
 */
import { apiFetch } from "./auth.js";

/**
 * 调用 WebUI 接口
 *
 * @param {string} path 接口名 (不含 /api/ 前缀)
 * @param {object} [payload] 请求体 (method 为 GET 时忽略)
 * @param {"POST" | "GET"} [method="POST"] 请求方法
 * @returns {Promise<any>} 解析后的响应体
 */
export async function callAPI(path, payload, method = "POST") {
	const options = { method };
	if (method !== "GET") {
		options.headers = { "Content-Type": "application/json" };
		options.body = JSON.stringify(payload ?? {});
	}

	const res = await apiFetch(`/api/${path}`, options);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.err || `HTTP ${res.status}`);
	return data;
}
