import type { Core } from "../../core";
import type { Request, Response } from "express";

export type WebUIFrontConfig = {
	enableTestLab?: boolean;
	/** 界面风格, 由设置页的 webui 域下发; 缺省按 "vsc" 处理 */
	uiStyle?: "vsc" | "md3" | "winui";
}

export interface WebUIAPI {
	/**
	 * 注册端点路径 (相对 `/api`); 省略时按模块文件自身的路径注册
	 *
	 * - 省略: `api/bots/list.ts` → `/api/bots/list`, 目录与文件名一起构成路由
	 * - 相对写法: `api/bots/list.ts` 内写 `"list"` 同样得到 `/api/bots/list`
	 * - 绝对写法: 以 `/` 开头时忽略所在目录(`"/list"` → `/api/list`)
	 */
	path?: string;
	/** 请求方法 */
	method: string;
	/** 是否鉴权 */
	auth: boolean;

	/** 普通 JSON 处理器 (与 stream 二选一)。可抛出 { err, code } 对象定制错误响应, code 作为 HTTP 状态码 */
	handler?(req: Request, core?: Core): Record<string, any> | string | Promise<string> | Promise<Record<string, any>>;
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
