/**
 * WebUI 鉴权工具: 基于 Node 内置 crypto 的轻量 JWT (HS256)
 *
 * - token 以 HttpOnly Cookie 形式下发, 前端 JS 不可见, 由浏览器自动携带
 *   (fetch 与 EventSource 均遵守同源 Cookie 策略, 无需前端手动拼接)
 * - 签名密钥由密码派生 (sha256), 密码更换后所有旧 token 立即验签失败,
 *   天然实现"改密即全量下线", 无需维护吊销列表
 */
import crypto from "crypto";
import type { Request } from "express";

/** token 有效期: 48 小时 */
export const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
/** token 在 Cookie 中的名称 */
export const AUTH_COOKIE = "chirucat_webui_token";

/** 密码 -> { key: 签名密钥, ver: 版本指纹 }。密钥随密码变化 */
function deriveKey(password: string) {
	const hash = crypto.createHash("sha256").update(password).digest("hex");
	return { key: hash, ver: hash.slice(0, 8) };
}

interface TokenPayload {
	sub: string;
	iat: number;
	exp: number;
	/** 密码哈希指纹, 用于显式检测密码更换 */
	ver: string;
}

/** 签发 token: 密钥由密码派生, 有效期默认 48h */
export function signToken(password: string, ttlMs: number = TOKEN_TTL_MS): string {
	const { key, ver } = deriveKey(password);
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ sub: "webui", iat: Date.now(), exp: Date.now() + ttlMs, ver })
	).toString("base64url");
	const sig = crypto.createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
	return `${header}.${payload}.${sig}`;
}

/**
 * 校验 token: 验签 + 版本指纹 + 过期检查。
 * 任何一步失败都返回 null (密码被篡改/更换、token 被篡改、过期均视为无效)。
 */
export function verifyToken(token: string, password: string): TokenPayload | null {
	const { key, ver } = deriveKey(password);
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [header, payload, sig] = parts;

	// 验签: timingSafeEqual 要求等长, 先比长度再比较, 防抛错
	const expected = crypto.createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
	if (sig!.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig!), Buffer.from(expected))) {
		return null;
	}

	let data: TokenPayload;
	try {
		data = JSON.parse(Buffer.from(payload!, "base64url").toString("utf-8"));
	} catch {
		return null;
	}

	// 版本指纹不符 -> 密码已更换, 旧 token 一律失效
	if (typeof data.ver !== "string" || data.ver !== ver) return null;
	// 过期检查
	if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
	return data;
}

/**
 * 从请求 Cookie 中读取 token。
 * 只关心 AUTH_COOKIE 一个字段, 避免为单字段引入依赖。
 */
export function readAuthToken(req: Request): string | null {
	const header = req.headers.cookie;
	if (!header) return null;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const name = part.slice(0, idx).trim();
		if (name === AUTH_COOKIE) {
			try {
				return decodeURIComponent(part.slice(idx + 1).trim());
			} catch {
				return null;
			}
		}
	}
	return null;
}

/** 常量时间密码比对: 双方先 sha256 固定长度, 再 timingSafeEqual, 防时序侧信道 */
export function safeEqualPassword(a: string, b: string): boolean {
	const ha = crypto.createHash("sha256").update(a).digest();
	const hb = crypto.createHash("sha256").update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
}
