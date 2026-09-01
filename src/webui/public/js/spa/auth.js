/**
 * WebUI 鉴权模块
 *
 * token 存于 HttpOnly Cookie, 由浏览器自动携带 (fetch / EventSource 均遵守
 * 同源 Cookie 策略), 前端 JS 完全接触不到 token。
 * 本模块只负责三件事:
 * - 查询鉴权状态 (verifyAuth): 进入页面时决定显示主界面还是登录卡片
 * - 提交登录 (login): 成功后 Cookie 由后端下发, 前端无需保存任何凭证
 * - 统一包装请求 (apiFetch): 401 时触发全局未授权回调, 切回登录态
 */

/** 未授权回调 (token 过期/换密码被吊销/服务端拒绝时触发), 由 app.js 注册 */
let unauthorizedHandler = null;

export function onUnauthorized(fn) {
	unauthorizedHandler = fn;
}

/** 查询当前是否已登录; 后端未配置密码时恒返回 true */
export async function verifyAuth() {
	try {
		const res = await fetch("/api/auth/verify", { credentials: "same-origin" });
		if (!res.ok) return false;
		const data = await res.json();
		return data.authed === true;
	} catch {
		return false;
	}
}

/** 提交密码登录; 失败时抛出 Error, message 可直接展示给用户 */
export async function login(password) {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
		credentials: "same-origin",
	});
	if (!res.ok) {
		let message = "登录失败";
		try {
			const data = await res.json();
			if (data?.err) message = data.err;
		} catch {
			/* 响应体解析失败时保留默认文案 */
		}
		throw new Error(message);
	}
}

/**
 * 统一 API 请求: 自动携带 Cookie, 401 时触发全局未授权回调。
 * 其他错误状态原样返回, 由调用方自行处理。
 */
export async function apiFetch(url, options = {}) {
	const res = await fetch(url, { ...options, credentials: "same-origin" });
	if (res.status === 401) {
		unauthorizedHandler?.();
		throw new Error("未登录或登录已过期");
	}
	return res;
}
