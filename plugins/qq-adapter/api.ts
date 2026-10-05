import type Logger from "../../src/utils/logger";
import type { AccessTokenManager } from "./access";
import { BASE_URL, REQUEST_TIMEOUT } from "./config";
import type { QQSendMessageResult, QQSendTarget } from "./types";

/** QQ API 调用失败 */
export class QQApiError extends Error {
	constructor(
		message: string,
		/** HTTP 状态码, 网络层失败时为 undefined */
		readonly status?: number
	) {
		super(message);
		this.name = "QQApiError";
	}
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * QQ 开放平台 HTTP 接口封装
 *
 * 只负责"发请求 / 解析响应 / 在失败时抛出 {@link QQApiError}"。
 * 把失败统一转成异常, 是为了让上层(动作处理器)用一个 try/catch 收口,
 * 不必在每个调用点判空返回值。
 *
 * 新增接口的姿势: 优先用 {@link request} 直接调用, 只有当某接口需要
 * 额外校验(如"响应必须带 id")时才像 {@link sendMessage} 那样包一层。
 */
export class QQApi {
	constructor(
		private access: AccessTokenManager,
		private logger: Logger
	) { }

	/** 取 token, 取不到直接失败 —— 后续请求没有意义 */
	private async requireToken(): Promise<string> {
		const token = await this.access.get();
		if (!token) throw new QQApiError("无可用 AccessToken");
		return token;
	}

	/**
	 * 发送消息
	 *
	 * `msg_type=2` 走文本(markdown), `msg_type=7` 走富媒体, 由调用方在 body 中给定。
	 * @returns 消息 id 与可选的引用 token
	 */
	async sendMessage(
		target: QQSendTarget,
		body: Record<string, unknown>
	): Promise<{ id: string; token?: string }> {
		const data = await this.request<QQSendMessageResult>(
			"POST",
			`${this.scenePath(target)}/messages`,
			body
		);

		// 发送成功但缺 id 不能算成功: 后续撤回/回复都依赖这个 id
		if (!data?.id) {
			throw new QQApiError(`响应缺少消息 id: ${JSON.stringify(data)}`);
		}

		const token = data.ext_info?.ref_idx;
		return token ? { id: String(data.id), token } : { id: String(data.id) };
	}

	/** 撤回消息 */
	async deleteMessage(target: QQSendTarget, messageId: string): Promise<void> {
		await this.request("DELETE", `${this.scenePath(target)}/messages/${messageId}`);
	}

	/**
	 * 发起一次 API 请求
	 *
	 * @param method HTTP 方法
	 * @param path 相对 `/v2/` 的路径, 如 `groups/xxx/messages`
	 * @param body 请求体, 为 `undefined` 时不发送 body 也不带 Content-Type
	 * @param timeout 超时(ms)
	 * @returns 解析后的响应体; 响应为空或非 JSON 时返回 `null`
	 */
	async request<T = any>(
		method: HttpMethod,
		path: string,
		body?: unknown,
		timeout: number = REQUEST_TIMEOUT
	): Promise<T> {
		const token = await this.requireToken();
		const headers: Record<string, string> = { Authorization: `QQBot ${token}` };
		if (body !== undefined) headers["Content-Type"] = "application/json";

		let response: Response;
		try {
			// body 为 undefined 时必须整个不写该属性: exactOptionalPropertyTypes 下
			// `body: undefined` 不是合法的 RequestInit
			const init: RequestInit = {
				method,
				headers,
				signal: AbortSignal.timeout(timeout)
			};
			if (body !== undefined) init.body = JSON.stringify(body);

			response = await fetch(`${BASE_URL}/v2/${path}`, init);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new QQApiError(`请求 ${method} ${path} 失败: ${msg}`);
		}

		// 先取文本: 失败响应体不一定是 JSON, 直接 resp.json() 会再抛一个无关异常
		const text = await response.text().catch(() => "");

		if (!response.ok) {
			const detail = text || response.statusText;
			this.logger.error(`API 失败 [${method} ${path}]: ${response.status} ${detail}`);
			throw new QQApiError(`QQ API 错误 (${response.status}): ${detail}`, response.status);
		}

		// DELETE 与 upload_part_finish 可能返回空体
		if (!text) return null as T;

		try {
			return JSON.parse(text) as T;
		} catch {
			// 少数接口返回非 JSON(如纯文本), 交由调用方决定如何处理
			return text as unknown as T;
		}
	}

	/** 群聊/单聊在接口路径上的分段名 */
	private scenePath(target: QQSendTarget): string {
		return target.type === "group" ? `groups/${target.id}` : `users/${target.id}`;
	}
}
