import type { Core } from "../../core";
import type { Request, Response } from "express";

export type WebUIConfig = {
	/** WebUI密码 */
	password?: string;
	/** Webui监听地址, 默认7636 */
	port?: number;
	/** WebUI主机, 默认127.0.0.1 */
	host?: string;
}

export interface WebUIAPI {
	/** 注册端点 */
	path: string;
	/** 请求方法 */
	method: string;
	/** 是否鉴权 */
	auth: boolean;

	/** 普通 JSON 处理器 (与 stream 二选一)。可抛出 { err, code } 对象定制错误响应, code 作为 HTTP 状态码 */
	handler?(req: Request, ctx?: Core): Record<string, any> | string | Promise<string> | Promise<Record<string, any>>;
	/** 流式处理器 (SSE 等), 负责管理连接的完整生命周期 (与 handler 二选一) */
	stream?(ctx: StreamContext): void | Promise<void>;
}

/** 流式 API 上下文: Core 实例 + express 的 req/res */
export interface StreamContext {
	/** Core 实例, 独立启动 WebUI 时可能为空 */
	core?: Core | undefined;
	req: Request;
	res: Response;
}
