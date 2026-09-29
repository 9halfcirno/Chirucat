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
import type { WebUIAPI, WebUIFrontConfig } from "./types";

/**
 * handler 抛出的自定义错误对象, 用于向前端返回带 HTTP 状态码的错误响应。
 * 形如 { err: "错误信息", code: 400 }, 其中 code 作为 HTTP 状态码。
 * details 为可选的附加信息(如字段级校验错误), 存在时原样透传给前端。
 */
interface APIError {
	err: string;
	code: number;
	details?: unknown;
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
	/**
	 * 本机访问是否免密码
	 *
	 * 开启后仅当对端是回环地址 (127.0.0.1 / ::1) 时跳过鉴权, 局域网仍旧需要密码 ——
	 * 适合"监听 0.0.0.0 + 自己这台机器不想每次登录"。默认 false。
	 */
	localNoAuth?: boolean;
	/** 前端静态资源目录, 默认 src/webui/public */
	staticDir?: string;
	/** 提供给 WebUI API handler 的 Core 实例 */
	core?: Core;
	/** API 模块目录, 默认 src/webui/server/api, 启动时自动加载其中的 API */
	apiDir?: string;
	/** 前端页面配置 */
	frontConfig?: WebUIFrontConfig;
}

/**
 * 是否为回环地址
 *
 * 只看 TCP 对端地址, **不**看 X-Forwarded-For —— 后者由客户端提供, 可以伪造。
 * Node 在双栈监听时会把 IPv4 回环表示成 IPv4-mapped IPv6, 一并认掉。
 */
function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	return address === "127.0.0.1"
		|| address === "::1"
		|| address === "::ffff:127.0.0.1";
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
	/** 当前监听的 server; relisten 会先关掉它并置空 */
	private server: HttpServer | undefined;

	/** 监听端口/地址: 可被 relisten 改写 (设置域热更新) */
	private port: number;
	private host: string;
	private readonly staticDir: string;
	private readonly apiDir: string;
	private readonly core?: Core;
	/**
	 * WebUI 密码; 未设置 (undefined/空串) 时所有 API 直接放行
	 *
	 * 声明成 `string | undefined` 而不是 `password?: string`: 热更新时需要显式
	 * 写回 undefined(清除密码), 而 `exactOptionalPropertyTypes` 不允许给可选属性
	 * 赋 undefined。
	 */
	private password: string | undefined;
	/** 本机访问是否跳过鉴权 */
	private localNoAuth: boolean;

	/** 是否已完成"加载 API + 注册路由"; 只做一次, relisten 不会重跑 */
	private initialized = false;
	/** 前端配置 */
	front?: WebUIFrontConfig;

	constructor(options: WebUIServerOptions = {}) {
		this.port = options.port ?? 7636;
		this.host = options.host ?? "0.0.0.0";
		this.localNoAuth = options.localNoAuth === true;
		this.staticDir = options.staticDir ?? path.join(root, "src", "webui", "public");
		this.apiDir = options.apiDir ?? path.join(root, "src", "webui", "server", "api");
		options.core && (this.core = options.core);
		options.password && (this.password = options.password);
		options.frontConfig && (this.front = options.frontConfig);
		
		this.setupMiddleware();
	}

	/**
	 * 启动服务器, 监听成功后 resolve
	 *
	 * 可重复调用: 首次会加载 API 目录并注册路由, 之后只重新监听 ——
	 * relisten 靠这一点换地址而不重复注册 handler。
	 */
	async start(): Promise<void> {
		if (!this.initialized) {
			// 启动前加载 api 目录下的 API 模块并注册路由
			await this.loadAPIs();
			this.setupRoutes();
			this.initialized = true;
			this.logger.log(`前端资源目录: ${this.staticDir}`);
		}
		await this.listenOn();
	}

	/**
	 * 换监听地址/端口
	 *
	 * 设置页自己就跑在这个服务器上, 所以只能"先关旧监听, 再在新地址上重开" ——
	 * 期间连接会断开, 前端要靠轮询 `/api/health` 等它回来。
	 * 换到被占用的端口会 reject, 此时旧监听已经关了, 调用方应把错误如实报出来。
	 */
	async relisten(port: number, host: string): Promise<void> {
		await this.close();
		this.port = port;
		this.host = host;
		await this.listenOn();
	}

	/** 热更新访问密码; 传空串表示清除密码(此后不再鉴权) */
	updateSecurity(options: { password?: string | undefined; localNoAuth?: boolean }): void {
		if (options.password !== undefined) {
			this.password = options.password ? options.password : undefined;
		}
		if (options.localNoAuth !== undefined) {
			this.localNoAuth = options.localNoAuth === true;
		}
	}

	/** 在当前位置上监听 (可重复调用) */
	private listenOn(): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = this.app.listen(this.port, this.host, () => {
				this.server = server;
				this.logger.log(`WebUI 服务器已启动: http://${this.host}:${this.port}`);
				resolve();
			});

			// 仅监听启动阶段的错误 (端口占用等)
			server.once("error", (err) => {
				this.logger.error(`WebUI 服务器启动失败: ${err.message}`);
				reject(err);
			});
		});
	}

	/** 停止服务器; 幂等 */
	close(): Promise<void> {
		return new Promise((resolve) => {
			const server = this.server;
			if (!server) {
				resolve();
				return;
			}
			// 先摘引用: 重复 close 或紧随其后的 relisten 都不会去关错对象
			this.server = undefined;
			server.closeAllConnections();
			server.close(() => {
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
			// 本机免密: 只看 TCP 对端地址, 不信 X-Forwarded-For
			if (this.localNoAuth && isLoopback(req.socket?.remoteAddress)) {
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
					// details 存在时一并透传(字段级校验错误等), 否则保持原来的响应形状
					res.status(status).json(
						err.details === undefined
							? { err: err.err, code: status }
							: { err: err.err, code: status, details: err.details },
					);
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
