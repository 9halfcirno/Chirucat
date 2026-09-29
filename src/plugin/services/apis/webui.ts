import type { WebUIServer } from "../../../webui/server/server";

/**
 * 服务插件视角的 WebUI
 *
 * 目前**刻意不公开任何方法**, 原因写在类里而不是留给读者猜:
 * - `WebUIServer` 现有的公开入口(`start` / `relisten` / `updateSecurity` / `close`)
 *   全是框架自己的生命周期与安全配置 —— 换监听会掐断正在回应的请求, 换密码等于
 *   交出 WebUI 的鉴权开关, 都不该由插件调用;
 * - 真正适合开放给插件的能力是"注册自己的 HTTP 路由", 但服务器目前只在启动时
 *   扫 `api/` 目录注册路由, 没有运行期注册入口。要开放得先给 `WebUIServer` 补上
 *   这个能力(连带前缀与鉴权策略), 不能在这里凭空承诺一个做不到的接口。
 *
 * 保留这个类是为了给 `CoreAPI.webui` 一个稳定的类型与扩展点: WebUI 未启用时
 * 该字段为 null, 插件据此判断能力是否存在。
 *
 * 服务器用 `#server`(ECMAScript 私有)持有 —— 将来在这里加安全方法时, 内部句柄
 * 仍不会被 `as any` 一步取出。
 */
export class WebUIAPI {
	readonly #server: WebUIServer;

	constructor(server: WebUIServer) {
		this.#server = server;
	}
}
