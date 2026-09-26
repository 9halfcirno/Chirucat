import type { PluginContext } from "../../src/plugin/contexts/context";
import { BASE_URL } from "./config";

export class AccessTokenManager {
	needUpdateTime: number = 0;
	token: string | null = null;
	private refreshPromise: Promise<any> | null = null; // 用于并发锁

	constructor(
		private ctx: PluginContext,
		private appId: string,
		private clientSecret: string
	) { }

	async get(): Promise<string | null> {
		const now = Date.now() / 1000; // 转换为秒

		// 如果 Token 为空或者临近过期（<= 5s），必须同步等待刷新完成
		if (!this.token || this.needUpdateTime - now <= 5) {
			await this.refresh();
		}
		// 如果进入预刷新区间（<= 50s），触发后台异步刷新，不阻塞当前返回
		else if (this.needUpdateTime - now <= 50) {
			this.refresh().catch(e => {
				this.ctx.logger.error(`后台预刷新 Token 失败: ${e.message}`);
			});
		}

		return this.token;
	}

	private async refresh(): Promise<any> {
		// 如果当前已经有一个正在进行的刷新请求，直接复用该 Promise，防止并发多次请求
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = (async () => {
			try {
				const response = await fetch(`${BASE_URL}/app/getAppAccessToken`, {
					method: "POST",
					headers: {
						'Content-Type': "application/json",
					},
					body: JSON.stringify({
						appId: this.appId,
						clientSecret: this.clientSecret
					})
				});

				if (!response.ok) {
					throw new Error(`HTTP 错误! status: ${response.status}`);
				}

				const res = await response.json();

				// 检验响应结构合法性
				if (!res || !res.access_token || !res.expires_in) {
					throw new Error(`返回数据异常: ${JSON.stringify(res)}`);
				}

				const now = Date.now() / 1000;
				// 铸币qq文档写的是number类型, 接口给我返回字符串, 神了
				this.needUpdateTime = now + parseInt(res.expires_in);
				this.token = res.access_token;

				this.ctx.logger.log(`AccessToken 刷新成功! new AccessToken: ${this.token!.slice(0, 6)}${"*".repeat(this.token!.length - 6)}`);
				return res;

			} catch (e: any) {
				this.ctx.logger.error(`AccessToken 刷新失败: ${e.message || e}`);
				throw e; // 抛出错误供上层捕获
			} finally {
				// 请求结束（无论成功或失败），清空锁
				this.refreshPromise = null;
			}
		})();

		return this.refreshPromise;
	}

	async refreshConfig(appId: string, secret: string) {
		this.token = null;
		this.refreshPromise = null;
		this.needUpdateTime = 0;
		this.appId = appId;
		this.clientSecret = secret;

		await this.refresh(); // 防止旧bot的token
	}
}