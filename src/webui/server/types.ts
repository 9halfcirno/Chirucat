import type { Core } from "../../core";

export interface WebUIAPI {
	/** 注册端点 */
	path: string;
	/** 请求方法 */
	method: string;
	/** 是否鉴权 */
	auth: boolean;

	/** 处理器 */
	handler(ctx?: Core): Record<string, any> | string;
}