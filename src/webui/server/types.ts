import type { Core } from "../../core";
import type { Request, Response } from "express";

export interface WebUIAPI {
	/** 注册端点 */
	path: string;
	/** 请求方法 */
	method: string;
	/** 是否鉴权 */
	auth: boolean;

	/** 普通 JSON 处理器 (与 stream 二选一) */
	handler?(ctx?: Core): Record<string, any> | string;
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
