import type Logger from "../../src/utils/logger";
import { BASE_URL, REQUEST_TIMEOUT } from "./config";

/**
 * AccessToken 管理
 *
 * QQ 的 AppAccessToken 有有效期(通常 7200s), 这里做了三件事:
 *
 * 1. 过期前 5s 内同步刷新 —— 调用方拿到的一定是可用 token;
 * 2. 进入 50s 预刷新区间时后台异步刷新, 不阻塞本次调用;
 * 3. 并发合并 —— 同一时刻只发一次刷新请求。
 *
 * `get()` 不抛异常: 失败时返回 `null` 并记日志。取 token 是每次调用的前置步骤,
 * 让它抛异常会把"网络抖动"升级成调用方的未捕获 rejection, 而调用方真正需要
 * 判断的只是"有没有 token"。
 */
export class AccessTokenManager {
	/** 当前 token */
	private token: string | null = null;
	/** token 过期时刻(秒级时间戳) */
	private expiresAt = 0;
	/** 进行中的刷新, 用于并发合并 */
	private pending: Promise<string | null> | null = null;

	constructor(
		private logger: Logger,
		private appId: string,
		private secret: string
	) { }

	/**
	 * 取一个可用 token
	 * @returns 可用 token; 刷新失败时为 `null`
	 */
	async get(): Promise<string | null> {
		const now = Date.now() / 1000;

		// 已过期或即将过期(<=5s): 必须等刷新完成, 否则返回的是失效 token
		if (!this.token || this.expiresAt - now <= 5) {
			await this.refresh();
		} else if (this.expiresAt - now <= 50) {
			// 预刷新区间: 后台刷新, 本次仍返回旧 token(它依然有效)
			void this.refresh();
		}

		return this.token;
	}

	/**
	 * 更新凭据并强制刷新
	 *
	 * 配置在 WebUI 中被改动后调用, 避免继续使用旧 Bot 的 token。
	 */
	async reset(appId: string, secret: string): Promise<void> {
		this.appId = appId;
		this.secret = secret;
		this.token = null;
		this.expiresAt = 0;
		await this.refresh();
	}

	/** 刷新 token, 并发调用会复用同一个请求 */
	private refresh(): Promise<string | null> {
		if (this.pending) return this.pending;

		const promise = this.doRefresh().finally(() => {
			// 只清理自己这一次的 pending: reset() 可能已经把它换掉了
			if (this.pending === promise) this.pending = null;
		});
		this.pending = promise;
		return promise;
	}

	private async doRefresh(): Promise<string | null> {
		try {
			const response = await fetch(`${BASE_URL}/app/getAppAccessToken`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT)
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const res = await response.json() as { access_token?: string; expires_in?: number | string };

			if (!res?.access_token || !res?.expires_in) {
				throw new Error(`返回数据异常: ${JSON.stringify(res)}`);
			}

			// 官方文档标称 number, 实际接口返回字符串, 两种都要能吃下
			const expiresIn = Number(res.expires_in);
			if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
				throw new Error(`expires_in 非法: ${res.expires_in}`);
			}

			this.token = res.access_token;
			this.expiresAt = Date.now() / 1000 + expiresIn;

			this.logger.log(`AccessToken 刷新成功 (有效期 ${expiresIn}s)`);
			return this.token;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.logger.error(`AccessToken 刷新失败: ${msg}`);
			return null;
		}
	}
}
