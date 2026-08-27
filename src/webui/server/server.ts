import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import type { Server as HttpServer } from "http";
import express from "express";
import type { ErrorRequestHandler, Express } from "express";
import Logger from "../../utils/logger";
import { root } from "../../utils/root";
import type { Core } from "../../core";
import type { WebUIAPI } from "./types";

/** WebUI 服务器配置选项 */
export interface WebUIServerOptions {
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

	constructor(options: WebUIServerOptions = {}) {
		this.port = options.port ?? 7636;
		this.host = options.host ?? "0.0.0.0";
		this.staticDir = options.staticDir ?? path.join(root, "src", "webui", "public");
		this.apiDir = options.apiDir ?? path.join(root, "src", "webui", "server", "api");
		options.core && (this.core = options.core);

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
			// 只加载 .ts 模块文件, 跳过 .d.ts 和 index 入口
			if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file === "index.ts") {
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

	/** 将单个 API 定义注册为 express 路由 */
	private registerAPI(api: WebUIAPI, file: string): void {
		const supportedMethods = ["get", "post", "put", "delete", "patch", "options", "head"] as const;
		const method = api.method.toLowerCase();
		if (!(supportedMethods as readonly string[]).includes(method)) {
			this.logger.warn(`跳过 API ${api.path}: 不支持的请求方法 ${api.method} (${file})`);
			return;
		}

		const routePath = `/api/${api.path.replace(/^\/+/, "")}`;
		this.logger.log(`注册 API: ${api.method.toUpperCase()} ${routePath} (${file})`);

		const routeMethod = method as (typeof supportedMethods)[number];

		// 流式 API (SSE): 直接交给处理器, 由处理器负责连接完整生命周期
		const stream = api.stream;
		if (stream) {
			this.app[routeMethod](routePath, (req, res) => {
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
		this.app[routeMethod](routePath, async (_req, res) => {
			try {
				// if (!this.core) {
				// 	this.logger.error(`API ${routePath} 需要 core 实例, 但 WebUIServer 未配置 core`);
				// 	res.status(500).json({ error: "Internal Server Error" });
				// 	return;
				// }

				const result: unknown = await api.handler?.(this.core);
				if (result === undefined) {
					res.status(204).end();
				} else if (typeof result === "string") {
					res.send(result);
				} else {
					res.json(result);
				}
			} catch (err) {
				this.logger.error(`API ${routePath} 处理请求时出错`, err);
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
