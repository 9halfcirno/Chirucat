import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import type { Server as HttpServer } from "http";
import express from "express";
import type { ErrorRequestHandler, Express, NextFunction, Request, RequestHandler, Response } from "express";
import Logger from "../../utils/logger";
import { AUTH_COOKIE, TOKEN_TTL_MS, readAuthToken, safeEqualPassword, signToken, verifyToken } from "./auth";
import { root } from "../../utils/root";
import type { Core } from "../../core";
import type { WebUIAPI } from "./types";

/**
 * handler 抛出的自定义错误对象, 用于向前端返回带 HTTP 状态码的错误响应。
 * 形如 { err: "错误信息", code: 400 }, 其中 code 作为 HTTP 状态码。
 */
interface APIError {
	err: string;
	code: number;
}

/** 判断抛出的对象是否为 { err, code } 形式的 API 错误 */
function isAPIError(err: unknown): err is APIError {
	if (!err || typeof err !== "object") return false;
	const candidate = err as Record<string, unknown>;
	return typeof candidate.err === "string" && typeof candidate.code === "number";
}

/** WebUI 服务器配置选项 */
export interface WebUIServerOptions {
	/** WebUI密码 */
	password?: string;
	/** 监听端口, 默认 7636 */
	port?: number;
	/** 监听地址, 默认 127.0.0.1, 仅本机可访问 */
	host?: string;
	/** 前端静态资源目录, 默认 src/webui/public */
	staticDir?: string;
	/** 提供给 WebUI API handler 的 Core 实例 */
	core?: Core;
	/** API 模块目录, 默认 src/webui/server/api, 启动时自动加载其中的 API */
	apiDir?: string;
}

/**
 * WebUI 本地服务器
 *
 * 负责托管 WebUI 前端静态资源, 并提供 WebUI 自身的 HTTP API 入口。
 * 启动时自动加载 api 目录下的 API 模块并注册路由。
 */
export class WebUIServer {
	readonly logger = new Logger("WebUI");

	private readonly app: Express = express();
	private server?: HttpServer;

	private readonly port: number;
	private readonly host: string;
	private readonly staticDir: string;
	private readonly apiDir: string;
	private readonly core?: Core;
	/** WebUI 密码; 未设置 (undefined/空串) 时所有 API 直接放行 */
	private readonly password?: string;

	constructor(options: WebUIServerOptions = {}) {
		this.port = options.port ?? 7636;
		this.host = options.host ?? "0.0.0.0";
		this.staticDir = options.staticDir ?? path.join(root, "src", "webui", "public");
		this.apiDir = options.apiDir ?? path.join(root, "src", "webui", "server", "api");
		options.core && (this.core = options.core);
		options.password && (this.password = options.password);

		this.setupMiddleware();
	}

	/** 启动服务器, 监听成功后 resolve */
	async start(): Promise<void> {
		// 启动前加载 api 目录下的 API 模块并注册路由
		await this.loadAPIs();
		this.setupRoutes();

		return new Promise((resolve, reject) => {
			const server = this.app.listen(this.port, this.host, () => {
				this.server = server;
				this.logger.log(`WebUI 服务器已启动: http://${this.host}:${this.port}`);
				this.logger.log(`前端资源目录: ${this.staticDir}`);
				resolve();
			});

			// 仅监听启动阶段的错误 (端口占用等)
			server.once("error", (err) => {
				this.logger.error(`WebUI 服务器启动失败: ${err.message}`);
				reject(err);
			});
		});
	}

	/** 停止服务器 */
	close(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.closeAllConnections();
			this.server.close(() => {
				this.logger.log("WebUI 服务器已停止");
				resolve();
			});
		});
	}

	private setupMiddleware() {
		// 解析 JSON 请求体, 供后续 WebUI API 使用
		this.app.use(express.json());

		// 托管前端静态资源
		this.app.use(express.static(this.staticDir));
	}

	/**
	 * 加载 api 目录下的所有 API 模块并注册到路由。
	 * 每个模块需默认导出一个 WebUIAPI 对象, 无效的模块会被跳过并记录日志。
	 */
	private async loadAPIs(): Promise<void> {
		let files: string[];
		try {
			files = await fs.readdir(this.apiDir);
		} catch (err) {
			this.logger.error(`读取 API 目录失败: ${this.apiDir}`, err);
			return;
		}

		for (const file of files) {
			// 只加载模块文件, 跳过 .d.ts 和 index 入口
			if (!(file.endsWith(".ts") || file.endsWith(".js")) || file.endsWith(".d.ts") || file === "index.ts") {
				continue;
			}

			const apiUrl = pathToFileURL(path.join(this.apiDir, file)).href;
			const mod = await import(apiUrl).catch((err) => {
				this.logger.error(`加载 API 模块失败: ${file}`, err);
				return null;
			});
			if (!mod) continue;

			const api = mod.default;
			if (!this.isWebUIAPI(api)) {
				this.logger.warn(`跳过无效的 API 模块: ${file} (缺少有效的默认导出)`);
				continue;
			}

			this.registerAPI(api, file);
		}
		this.logger.log(`后端API端点注册完成`)
	}

	/** 校验模块默认导出是否为合法的 WebUIAPI 定义 */
	private isWebUIAPI(api: unknown): api is WebUIAPI {
		if (!api || typeof api !== "object") return false;
		const candidate = api as Partial<WebUIAPI>;
		return (
			typeof candidate.path === "string" &&
			typeof candidate.method === "string" &&
			(typeof candidate.handler === "function" || typeof candidate.stream === "function")
		);
	}

	/**
	 * 鉴权中间件: 仅对 auth:true 的 API 生效。
	 * - 未配置密码: 直接放行
	 * - 已配置密码: 从 HttpOnly Cookie 取 token, 验签失败返回 401
	 */
	private authRequired(): RequestHandler {
		return (req: Request, res: Response, next: NextFunction) => {
			if (!this.password) {
				next();
				return;
			}
			const token = readAuthToken(req);
			if (!token || !verifyToken(token, this.password)) {
				res.status(401).json({ err: "未登录或登录已过期", code: 401 });
				return;
			}
			next();
		};
	}

	/** 将单个 API 定义注册为 express 路由 */
	private registerAPI(api: WebUIAPI, file: string): void {
		const supportedMethods = ["get", "post", "put", "delete", "patch", "options", "head"] as const;
		const method = api.method.toLowerCase();
		if (!(supportedMethods as readonly string[]).includes(method)) {
			this.logger.warn(`跳过 API ${api.path}: 不支持的请求方法 ${api.method} (${file})`);
			return;
		}

		const routePath = `/api/${api.path.replace(/^\/+/, "")}`;
		// this.logger.log(`注册 API: ${api.method.toUpperCase()} ${routePath} (${file})`);

		const routeMethod = method as (typeof supportedMethods)[number];
		// 声明 auth:true 的 API 在 handler 之前先过鉴权中间件
		const middlewares: RequestHandler[] = api.auth ? [this.authRequired()] : [];

		// 流式 API (SSE): 直接交给处理器, 由处理器负责连接完整生命周期
		const stream = api.stream;
		if (stream) {
			this.app[routeMethod](routePath, ...middlewares, (req, res) => {
				try {
					void stream({ core: this.core, req, res });
				} catch (err) {
					this.logger.error(`API ${routePath} 处理流式请求时出错`, err);
					if (res.headersSent) {
						res.end();
					} else {
						res.status(500).json({ error: "Internal Server Error" });
					}
				}
			});
			return;
		}

		// 普通 JSON API
		this.app[routeMethod](routePath, ...middlewares, async (_req, res) => {
			try {
				// if (!this.core) {
				// 	this.logger.error(`API ${routePath} 需要 core 实例, 但 WebUIServer 未配置 core`);
				// 	res.status(500).json({ error: "Internal Server Error" });
				// 	return;
				// }

				const result: unknown = await api.handler?.(_req, this.core);
				if (result === undefined) {
					res.status(204).end();
				} else if (typeof result === "string") {
					res.send(result);
				} else {
					res.json(result);
				}
			} catch (err) {
				this.logger.error(`API ${routePath} 处理请求时出错`, err);

				// handler 可抛出 { err, code } 对象, 将 code 作为 HTTP 状态码, 原样返回给前端
				if (isAPIError(err)) {
					const status =
						Number.isInteger(err.code) && err.code >= 400 && err.code <= 599
							? err.code
							: 500;
					res.status(status).json({ err: err.err, code: status });
					return;
				}

				res.status(500).json({ error: "Internal Server Error" });
			}
		});
	}

	private setupRoutes() {
		// 健康检查, 供前端确认后端存活
		this.app.get("/api/health", (_req, res) => {
			res.json({
				status: "ok",
				name: "Chirucat WebUI",
				time: Date.now(),
			});
		});

		// ---- 鉴权端点 (白名单, 不挂鉴权中间件) ----

		// 登录: 校验密码后以 HttpOnly Cookie 下发 JWT (有效期 48h)
		this.app.post("/api/auth/login", (req, res) => {
			if (!this.password) {
				res.status(403).json({ err: "未配置密码, 无需登录", code: 403 });
				return;
			}
			const body = (req.body ?? {}) as { password?: unknown };
			const password = typeof body.password === "string" ? body.password : "";
			if (!password) {
				res.status(400).json({ err: "缺少密码", code: 400 });
				return;
			}
			if (!safeEqualPassword(this.password, password)) {
				res.status(401).json({ err: "密码错误", code: 401 });
				return;
			}
			const token = signToken(this.password);
			res.cookie(AUTH_COOKIE, token, {
				httpOnly: true, // JS 不可读, 防 XSS 窃取
				sameSite: "strict", // 防 CSRF
				path: "/",
				maxAge: TOKEN_TTL_MS,
			});
			res.json({ ok: true });
		});

		// 鉴权状态查询: 前端进入页面时调用; 无密码时恒为已登录
		this.app.get("/api/auth/verify", (req, res) => {
			const token = readAuthToken(req);
			const authed = !this.password || (token !== null && verifyToken(token, this.password) !== null);
			res.json({ authed });
		});

		// 未匹配的 /api 路由统一返回 JSON 404
		this.app.use("/api", (_req, res) => {
			res.status(404).json({ error: "Not Found" });
		});

		// 兜底: 其余未匹配路径
		this.app.use((_req, res) => {
			res.status(404).json({ error: "Not Found" });
		});

		// 兜底: 统一错误处理
		this.app.use(((err, _req, res, _next) => {
			this.logger.error("处理请求时出错:", err);
			res.status(500).json({ error: "Internal Server Error" });
		}) satisfies ErrorRequestHandler);
	}
}

// 直接运行时启动一个默认实例
if (import.meta.main) {
	const server = new WebUIServer();
	server.start();
}
