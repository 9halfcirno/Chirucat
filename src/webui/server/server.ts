import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import type { Server as HttpServer } from "http";
import express from "express";
import type { ErrorRequestHandler, Express, NextFunction, Request, RequestHandler, Response, Router } from "express";
import Logger from "../../utils/logger";
import { StateError } from "../../errors/state-error";
import { AUTH_COOKIE, TOKEN_TTL_MS, readAuthToken, safeEqualPassword, signToken, verifyToken } from "./auth";
import { root } from "../../utils/root";
import type { Core } from "../../core";
import type { WebUIAPI, WebUIFrontConfig } from "./types";
import { ServicePageRegistry, type ServicePageDef, type ServicePageView } from "./service-pages";

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

/** 支持的请求方法; 核心 API 模块与服务插件路由共用同一份列表 */
const SUPPORTED_METHODS = ["get", "post", "put", "delete", "patch", "options", "head"] as const;

/** 服务插件 WebUI 的挂载根: `/service/<插件id>/api/...` 与 `/service/<插件id>/public` */
const SERVICE_ROOT = "/service";

/**
 * 运行期注册的服务插件路由
 *
 * 端点落在 `/service/<插件id>/api/<path>` 下(命名空间与归属由框架拼装, 插件只给
 * 相对路径), 只交给插件"已解析的请求体 + 返回值", 不交出 req / res —— 插件不需要、
 * 也不该触碰 HTTP 连接的完整生命周期(那是核心 API 模块与 stream 处理器的事)。
 */
export interface ServiceAPIRoute {
	/** 相对 `/service/<插件id>/api` 的路径, 必须是单段(形如 `filter_list`, 不含 `/`) */
	path: string;
	/** 请求方法, 取值同核心 API */
	method: string;
	/**
	 * 是否需要鉴权; 缺省 `true`(与核心 API 的默认一致, 插件端点不会意外裸奔)
	 *
	 * 显式写成 `boolean | undefined`: 调用方可能原样透传一个可选值, 而
	 * `exactOptionalPropertyTypes` 下"可选"与"可以是 undefined"不是一回事。
	 */
	auth?: boolean | undefined;
	/**
	 * 处理器: 入参是已解析的 JSON 请求体, 返回值按普通 JSON API 的规则写出
	 * (undefined → 204, string → 原样发送, 其余 → JSON)。
	 * 可抛出 `{ err, code }` 对象定制错误响应, code 作为 HTTP 状态码。
	 */
	handler: (body: unknown) => unknown;
}

/** 一条已注册的服务插件路由 */
interface ServiceRouteEntry {
	/** 注册者(服务插件 id), 仅用于错误信息 */
	owner: string;
	/** 是否需要鉴权 */
	auth: boolean;
	/** 处理器 */
	handler: (body: unknown) => unknown;
	/** 是否活跃: 归属上下文释放后置为 false, 请求返回 503 而不是 404 */
	active: boolean;
}

/** 一个服务插件的静态资源挂载 */
interface ServiceStaticEntry {
	/** 是否活跃: 归属上下文释放后置为 false, 请求落到 404 兜底 */
	active: boolean;
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
	/**
	 * 核心 API 模块注册到的 router, 挂在 `/api`
	 *
	 * 服务插件**不**走这里: 它们有自己的命名空间(见 `serviceRouter`)。
	 * 两个 router 都挂在各自的 404 兜底之前, 因此服务器启动后仍能往里加路由。
	 */
	private readonly apiRouter: Router = express.Router();
	/**
	 * 服务插件 WebUI 的 router, 挂在 `/service`
	 *
	 * 每个插件独占 `/service/<插件id>/` 前缀:
	 * - 端点注册在 `/service/<插件id>/api/<路径>`
	 * - 插件代码目录下的 `public/` 挂在 `/service/<插件id>/public`
	 *
	 * 带上命名空间之后, 插件之间、插件与核心端点之间都不会撞路径 —— 插件既抢不走
	 * 核心端点, 也看不到别的插件的端点。
	 */
	private readonly serviceRouter: Router = express.Router();
	/** 运行期注册的服务插件端点, 键为 `METHOD /service/<id>/api/<路径>` */
	private readonly serviceRoutes = new Map<string, ServiceRouteEntry>();
	/** 已挂到 serviceRouter 上的端点键: 重复注册只换条目, 不重复挂载 */
	private readonly mountedRouteKeys = new Set<string>();
	/** 已挂载的插件静态目录, 键为 `/service/<id>/public` */
	private readonly serviceStatics = new Map<string, ServiceStaticEntry>();
	/** 已占用的插件命名空间: 小写 id -> 原始 id; 拒绝只有大小写不同的重复 id */
	private readonly serviceNamespaces = new Map<string, string>();
	/**
	 * 服务插件注册的 WebUI 页面 (活动栏一级导航 + Bot 详情窗口的二级导航)
	 *
	 * 前端通过 `GET /api/get_webui_pages` 拉取这份清单, 并按版本号做幂等对账;
	 * 清单里只有活着的页面 —— 服务上下文释放时注册表条目会被注销函数清掉。
	 */
	private readonly servicePages = new ServicePageRegistry();
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

	/**
	 * 当前监听的地址; 未监听时为 null
	 *
	 * 端口配置为 0(由系统分配)时, 这里拿到的是**实际绑定**的端口, 供测试与诊断使用。
	 */
	get listening(): { host: string; port: number } | null {
		const address = this.server?.address();
		if (!address || typeof address === "string") return null;
		return { host: this.host, port: address.port };
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
			// 只加载模块文件, 跳过 .d.ts、index 入口与 _ 前缀的内部模块(如 _shared.ts)
			const isModule = file.endsWith(".ts") || file.endsWith(".js");
			if (!isModule || file.endsWith(".d.ts") || file === "index.ts" || file.startsWith("_")) {
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
			if (this.isAuthorized(req)) {
				next();
				return;
			}
			res.status(401).json({ err: "未登录或登录已过期", code: 401 });
		};
	}

	/** 该请求是否已通过鉴权: 未配置密码 / 本机免密 / 有效 Cookie 三者之一 */
	private isAuthorized(req: Request): boolean {
		if (!this.password) return true;
		// 本机免密: 只看 TCP 对端地址, 不信 X-Forwarded-For
		if (this.localNoAuth && isLoopback(req.socket?.remoteAddress)) return true;
		const token = readAuthToken(req);
		return Boolean(token && verifyToken(token, this.password) !== null);
	}

	/** 归一化请求方法; 不在支持列表内时返回 null */
	private normalizeMethod(method: string): (typeof SUPPORTED_METHODS)[number] | null {
		const lower = method.toLowerCase();
		return (SUPPORTED_METHODS as readonly string[]).includes(lower)
			? lower as (typeof SUPPORTED_METHODS)[number]
			: null;
	}

	/** 将单个 API 定义注册为 express 路由 (核心 API 模块启动时调用) */
	private registerAPI(api: WebUIAPI, file: string): void {
		const method = this.normalizeMethod(api.method);
		if (!method) {
			this.logger.warn(`跳过 API ${api.path}: 不支持的请求方法 ${api.method} (${file})`);
			return;
		}

		// router 内部的路径不含挂载前缀(`apiRouter` 已挂在 /api 上), 对外 URL 才带
		const routePath = `/${api.path.replace(/^\/+/, "")}`;
		const urlPath = `/api${routePath}`;
		// this.logger.log(`注册 API: ${method.toUpperCase()} ${urlPath} (${file})`);

		// 声明 auth:true 的 API 在 handler 之前先过鉴权中间件
		const middlewares: RequestHandler[] = api.auth ? [this.authRequired()] : [];

		// 流式 API (SSE): 直接交给处理器, 由处理器负责连接完整生命周期
		const stream = api.stream;
		if (stream) {
			this.apiRouter[method](routePath, ...middlewares, (req, res) => {
				try {
					void stream({ core: this.core, req, res });
				} catch (err) {
					this.logger.error(`API ${urlPath} 处理流式请求时出错`, err);
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
		this.apiRouter[method](routePath, ...middlewares, (req, res) => {
			void this.respond(res, urlPath, () => api.handler?.(req, this.core));
		});
	}

	/**
	 * 运行期注册一条服务插件端点
	 *
	 * 端点落在**该插件自己的命名空间**里: `/service/<插件id>/api/<路径>`, 因此
	 * 插件之间、插件与核心 `/api/*` 之间都不会撞路径。
	 *
	 * 约定:
	 * - `path` 必须是**单段**(形如 `filter_list`, 不含 `/`), 不允许用前缀或通配扩张;
	 * - 同一个插件重复注册同一路径只换处理器(服务停用后重新启用是正常路径);
	 * - 服务器启动后也能注册: `serviceRouter` 挂在 404 兜底之前(见 setupRoutes)。
	 *
	 * @param owner 注册者(服务插件 id), 同时构成 URL 里的命名空间
	 * @param route 路由定义
	 * @returns 注销函数; 注销后该路径返回 503(而不是消失), 前端能拿到明确原因
	 */
	registerServiceAPI(owner: string, route: ServiceAPIRoute): () => void {
		const segment = this.serviceSegment(owner);

		if (typeof route?.path !== "string" || !/^[A-Za-z0-9_-]+$/.test(route.path)) {
			throw new StateError(
				`服务插件 ${owner} 注册端点失败: path 必须是单段(字母/数字/下划线/连字符), 收到 ${JSON.stringify(route?.path)}`,
			);
		}

		const method = this.normalizeMethod(String(route.method));
		if (!method) {
			throw new StateError(`服务插件 ${owner} 注册端点 ${route.path} 失败: 不支持的请求方法 ${String(route.method)}`);
		}
		if (typeof route.handler !== "function") {
			throw new StateError(`服务插件 ${owner} 注册端点 ${route.path} 失败: handler 必须是函数`);
		}

		// router 内部的路径不含挂载前缀(`serviceRouter` 已挂在 /service 上), 对外 URL 才带
		const innerPath = `${segment}/api/${route.path}`;
		const urlPath = `${SERVICE_ROOT}${innerPath}`;
		const key = `${method} ${urlPath}`;

		const entry: ServiceRouteEntry = {
			owner,
			auth: route.auth !== false,
			handler: route.handler,
			active: true,
		};
		this.serviceRoutes.set(key, entry);

		// 处理器只在首次注册时挂到 router 上: 之后靠条目查表, 重新注册只换条目
		if (!this.mountedRouteKeys.has(key)) {
			this.mountedRouteKeys.add(key);
			this.serviceRouter[method](innerPath, (req, res) => {
				void this.handleServiceRequest(key, req, res);
			});
		}

		this.logger.log(`服务插件 ${owner} 已注册端点: ${method.toUpperCase()} ${urlPath}`);

		return () => {
			// 只把本次注册的条目置为非活跃: 归属校验为同一个对象, 重新注册后的新条目不受影响
			const current = this.serviceRoutes.get(key);
			if (current === entry) entry.active = false;
		};
	}

	/**
	 * 运行期注册一个属于本服务插件的 WebUI 页面
	 *
	 * 与 `registerServiceAPI` 同构: 插件只给**相对 public/ 的路径**, 命名空间、
	 * 版本化的模块 URL 都由框架拼装; 返回的注销函数由服务上下文代管, 因此
	 * **服务停用即页面消失**(前端下一次对账就会把它从导航里摘掉)。
	 *
	 * @param owner 服务插件 id (同时是 `/service/<id>/` 的命名空间)
	 * @param scope 作用域: app = 活动栏一级导航, bot = Bot 详情窗口的二级导航
	 * @param def 页面定义
	 * @returns 注销函数
	 */
	registerServicePage(owner: string, scope: "app" | "bot", def: ServicePageDef): () => void {
		// 先过命名空间校验: 非法 id / 大小写冲突在这里就报出来, 而不是等到拼 URL
		const segment = this.serviceSegment(owner);
		const dispose = this.servicePages.register(owner, segment, scope, def);
		this.logger.log(`服务插件 ${owner} 已注册 WebUI 页面: ${scope}/${def?.id}`);
		return dispose;
	}

	/** 当前的服务插件页面清单 (按 order 升序, URL 已拼好并带版本参数) */
	getServicePages(): ServicePageView[] {
		return this.servicePages.list();
	}

	/** 页面清单版本号: 每次增删都变, 前端据此判断要不要重新对账 */
	get servicePagesVersion(): number {
		return this.servicePages.version;
	}

	/**
	 * 挂载一个服务插件的静态资源目录
	 *
	 * 约定: 插件代码目录下的 `public/` 对应 `/service/<插件id>/public`。目录不存在时
	 * 不挂载(没有静态资源的插件不占这个位置), 挂载由框架在服务加载时完成, 插件不必
	 * (也无法)自己处理静态文件。
	 *
	 * 静态资源与核心前端一样**不鉴权**: 它只是页面用的 js/css/图片, 真正的数据入口
	 * 是同一命名空间下的 `/api`, 那里默认要求鉴权。
	 *
	 * @param owner 服务插件 id
	 * @param dir 静态目录的绝对路径
	 * @returns 注销函数; 注销后该前缀返回 404
	 */
	mountServicePublic(owner: string, dir: string): () => void {
		const segment = this.serviceSegment(owner);
		const innerPath = `${segment}/public`;
		const handler = express.static(dir, { index: false, redirect: false });

		let entry = this.serviceStatics.get(innerPath);
		if (!entry) {
			entry = { active: true };
			this.serviceStatics.set(innerPath, entry);
			this.serviceRouter.use(innerPath, (req, res, next) => {
				const current = this.serviceStatics.get(innerPath);
				if (!current || !current.active) {
					next(); // 服务未启用: 交给后续的 404 兜底
					return;
				}
				handler(req, res, next);
			});
			this.logger.log(`服务插件 ${owner} 已挂载静态资源: ${SERVICE_ROOT}${innerPath}`);
		}
		entry.active = true;

		const mounted = entry;
		return () => {
			// 同上: 只有当前条目还是本次挂载的那一个才置为非活跃
			if (this.serviceStatics.get(innerPath) === mounted) mounted.active = false;
		};
	}

	/**
	 * 取一个服务插件在 `serviceRouter` 里的路径段 `/<id>`, 顺带校验 id 能安全地做路径段
	 *
	 * manifest 的 id 没有字符集约束, 直接拼进 URL 会带来 `..` / `/` 这类路径问题,
	 * 也会让两个只在大小写上有差别的 id 抢同一个命名空间(express 路由默认不分大小写)。
	 */
	private serviceSegment(owner: string): string {
		if (typeof owner !== "string" || !/^[A-Za-z0-9_-]+$/.test(owner)) {
			throw new StateError(
				`服务插件 id 不能用作 WebUI 命名空间: ${JSON.stringify(owner)} (只允许字母/数字/下划线/连字符)`,
			);
		}

		const lower = owner.toLowerCase();
		const existing = this.serviceNamespaces.get(lower);
		if (existing !== undefined && existing !== owner) {
			throw new StateError(`服务插件 ${owner} 的 WebUI 命名空间与 ${existing} 冲突(路由不分大小写)`);
		}
		this.serviceNamespaces.set(lower, owner);

		return `/${owner}`;
	}

	/** 处理一条服务插件端点的请求: 服务未启用 → 503, 鉴权失败 → 401, 其余交给处理器 */
	private async handleServiceRequest(key: string, req: Request, res: Response): Promise<void> {
		const entry = this.serviceRoutes.get(key);
		if (!entry || !entry.active) {
			const owner = entry?.owner ?? "?";
			res.status(503).json({ err: `服务插件 ${owner} 未启用`, code: 503 });
			return;
		}
		if (entry.auth && !this.isAuthorized(req)) {
			res.status(401).json({ err: "未登录或登录已过期", code: 401 });
			return;
		}
		await this.respond(res, key, () => entry.handler(req.body));
	}

	/**
	 * 执行一个 API 处理器并把结果/错误写进响应
	 *
	 * 核心 API 模块与服务插件路由共用同一份错误映射(`{ err, code }` → HTTP 状态码)。
	 * @param label 日志与错误信息里标识该端点的文本
	 * @param run 调用处理器的闭包
	 */
	private async respond(res: Response, label: string, run: () => unknown): Promise<void> {
		try {
			const result = await run();
			if (result === undefined) {
				res.status(204).end();
			} else if (typeof result === "string") {
				res.send(result);
			} else {
				res.json(result);
			}
		} catch (err) {
			this.logger.error(`API ${label} 处理请求时出错`, err);

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
	}

	private setupRoutes() {
		// 核心 API 模块与服务插件运行期注册的端点都在各自 router 里;
		// 必须先于两处 404 兜底挂载, 否则后加的路由永远匹配不到
		this.app.use("/api", this.apiRouter);
		// 服务插件命名空间: /service/<插件id>/api/... 与 /service/<插件id>/public
		this.app.use(SERVICE_ROOT, this.serviceRouter);

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
