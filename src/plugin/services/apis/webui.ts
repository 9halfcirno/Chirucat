import type { WebUIServer } from "../../../webui/server/server";
import type { ServicePageDef, ServiceMenuItemDef, ServicePageScope } from "../../../webui/server/service-pages";

/**
 * 服务插件注册端点的定义
 *
 * 端点落在**本插件自己的命名空间**里: `/service/<插件id>/api/<path>` —— 命名空间
 * 由框架按归属插件拼装, 插件只给相对路径, 不用(也不该)把 id 写进 URL。
 *
 * 只交出"已解析的请求体 + 返回值", 不交出 `req` / `res`:
 * - 插件不该碰 HTTP 连接的生命周期(流式响应等由核心 API 模块负责);
 * - 鉴权由框架按 `auth` 决定并实现, 插件既不用也无法绕开。
 */
export type PluginWebUIRoute = {
	/**
	 * 相对 `/service/<插件id>/api` 的路径, **必须是单段**: 只允许字母/数字/下划线/连字符,
	 * 例如 `filter_list` → `/service/chirucat-filter/api/filter_list`
	 *
	 * 单段是硬约束: 插件无法用前缀或通配去抢占别的路径。
	 */
	path: string;
	/** 请求方法, 取值同核心 API (get / post / put / delete / patch / options / head) */
	method: string;
	/** 是否需要鉴权, 缺省 `true` —— 插件端点默认不裸奔 */
	auth?: boolean;
	/**
	 * 处理器, 入参是已解析的 JSON 请求体
	 *
	 * 返回值按普通 JSON API 的规则写出: `undefined` → 204, `string` → 原样发送,
	 * 其余 → JSON。抛出 `{ err: string, code: number }` 对象可定制错误响应,
	 * `code` 作为 HTTP 状态码(`details` 字段存在时一并透传给前端)。
	 * 也可以是异步函数。
	 */
	handler: (body: unknown) => unknown;
};

/** 插件注册的二级菜单项 (与页面定义同一份形状, 便于文档统一) */
export type PluginMenuItem = ServiceMenuItemDef;

/**
 * 插件注册的 WebUI 页面
 *
 * 字段与前端页面契约一致, 但资源路径一律**相对插件自己的 `public/`**:
 * 框架会拼成 `/service/<插件id>/public/<path>?v=<版本>`, 因此插件不必知道自己的 id
 * 会出现在哪个前缀下, 也无法借路径穿越逃出自己的命名空间。
 *
 * ```ts
 * // 活动栏一级导航
 * ctx.core.webui?.pages.register({
 *   id: "global", title: "黑白名单", icon: "shield.svg", order: 50,
 *   module: "page/global.js",
 *   menu: [{ title: "全局名单", module: "page/global.js" }],
 * });
 *
 * // Bot 详情窗口里的二级导航
 * ctx.core.webui?.bot.pages.register({
 *   id: "filter", title: "名单", icon: "shield.svg", order: 30,
 *   module: "page/bot.js",
 * });
 * ```
 */
export type PluginPage = ServicePageDef;

/** 页面注册的返回: 注销函数 (通常不用自己调用, 上下文释放时会代管) */
export type PluginPageDispose = () => void;

/**
 * 页面注册的共用实现: 走服务器注册 + 把注销函数交给上下文代管
 *
 * 两个作用域只有 scope 不同, 因此共用一个函数, 而不是让两个类互相访问私有字段。
 */
function registerPage(
	server: WebUIServer,
	serviceId: string,
	track: ((dispose: () => void) => void) | undefined,
	scope: ServicePageScope,
	page: PluginPage,
): PluginPageDispose {
	const dispose = server.registerServicePage(serviceId, scope, page);
	track?.(dispose);
	return dispose;
}

/**
 * 一级导航页面注册 (`ctx.core.webui.pages`)
 *
 * 注册的页面进活动栏, 与核心页面平级; 页面模块由浏览器按需 `import()`,
 * 默认导出可以是 `{ render(container, app) { ... } }` 页面对象。
 */
export class WebUIPagesAPI {
	readonly #server: WebUIServer;
	readonly #serviceId: string;
	readonly #track: ((dispose: () => void) => void) | undefined;

	constructor(server: WebUIServer, serviceId: string, track?: (dispose: () => void) => void) {
		this.#server = server;
		this.#serviceId = serviceId;
		this.#track = track;
	}

	/**
	 * 注册一个活动栏页面
	 * @param page 页面定义 (相对路径)
	 * @returns 注销函数; 上下文释放时框架会自动调用它
	 * @throws 路径非法、id 非单段、与别的插件撞前端 id 时抛 StateError
	 */
	register(page: PluginPage): PluginPageDispose {
		return registerPage(this.#server, this.#serviceId, this.#track, "app", page);
	}
}

/**
 * Bot 详情窗口的页面注册 (`ctx.core.webui.bot.pages`)
 *
 * 注册的页面进 Bot 详情窗口左侧那排图标按钮, 与"信息 / 插件 / 设置"平级;
 * 页面模块的 `render(container, bot, app)` 会拿到**当前 Bot** —— 同一份代码服务
 * 于任意 Bot, 不要在里面写死某个 id。
 *
 * 服务停用(上下文释放)时这些页面会从**已经打开的** Bot 窗口里即时消失:
 * 前端按清单对账并通知窗口重绘(见 js/spa/service-pages.js)。
 */
export class WebUIBotPagesAPI {
	readonly #server: WebUIServer;
	readonly #serviceId: string;
	readonly #track: ((dispose: () => void) => void) | undefined;

	constructor(server: WebUIServer, serviceId: string, track?: (dispose: () => void) => void) {
		this.#server = server;
		this.#serviceId = serviceId;
		this.#track = track;
	}

	/**
	 * 注册一个 Bot 详情窗口页面
	 * @param page 页面定义 (相对路径; `menu` 在这里没有意义, 会被忽略)
	 * @returns 注销函数
	 */
	register(page: PluginPage): PluginPageDispose {
		return registerPage(this.#server, this.#serviceId, this.#track, "bot", page);
	}
}

/** Bot 维度的 WebUI 注册入口 (目前只有窗口页面, 留出将来放窗口级能力的位置) */
export class WebUIBotAPI {
	readonly pages: WebUIBotPagesAPI;

	constructor(server: WebUIServer, serviceId: string, track?: (dispose: () => void) => void) {
		this.pages = new WebUIBotPagesAPI(server, serviceId, track);
	}
}

/**
 * 服务插件视角的 WebUI
 *
 * 开放**三件事**:
 * - 注册自己的 HTTP 端点 (`register`, 落在 `/service/<插件id>/api/<路径>`);
 * - 注册活动栏页面 (`pages.register`);
 * - 注册 Bot 详情窗口页面 (`bot.pages.register`);
 *
 * 以及(由框架自动完成的)托管插件自带的静态资源 —— `services/<插件id>/public` 挂在
 * `/service/<插件id>/public`, 插件不必也无法自己处理静态文件。生命周期与安全配置
 * 仍然不开放: `start` / `relisten` / `updateSecurity` / `close` 要么会掐断正在回应的
 * 请求, 要么等于交出 WebUI 的鉴权开关, 都不该由插件调用。
 *
 * 端点落在插件自己的命名空间里(见 `PluginWebUIRoute`), 因此插不进核心 `/api/*`,
 * 也看不见别的插件的端点。注册返回的注销函数由上下文在释放时统一调用, 之后该路径
 * 返回 503("服务插件 xxx 未启用")而不是 404, 前端能拿到明确原因。
 *
 * WebUI 未启用时 `ctx.core.webui` 为 `null`, 插件据此跳过注册(能力不存在,
 * 而不是注册失败)。
 *
 * 服务器句柄用 `#server`(ECMAScript 私有)持有: 将来在这里加方法时, 内部句柄
 * 仍不会被 `as any` 一步取出。
 */
export class WebUIAPI {
	readonly #server: WebUIServer;
	/** 归属的服务插件 id, 用于错误信息与运行日志 */
	readonly #serviceId: string;
	/** 记录注销函数的回调(由服务插件上下文提供, 释放时统一注销) */
	readonly #track: ((dispose: () => void) => void) | undefined;
	/** 一级导航页面注册入口 */
	readonly pages: WebUIPagesAPI;
	/** Bot 维度的注册入口 */
	readonly bot: WebUIBotAPI;

	constructor(server: WebUIServer, serviceId: string, track?: (dispose: () => void) => void) {
		this.#server = server;
		this.#serviceId = serviceId;
		this.#track = track;
		this.pages = new WebUIPagesAPI(server, serviceId, track);
		this.bot = new WebUIBotAPI(server, serviceId, track);
	}

	/**
	 * 注册一个属于本服务插件的 HTTP 端点
	 * @param route 路由定义
	 * @returns 注销函数; 上下文释放时框架会自动调用它
	 * @throws 路径非法/方法不支持/handler 非函数时抛 StateError
	 */
	register(route: PluginWebUIRoute): () => void {
		const dispose = this.#server.registerServiceAPI(this.#serviceId, {
			path: route.path,
			method: route.method,
			auth: route.auth,
			handler: route.handler,
		});
		this.#track?.(dispose);
		return dispose;
	}
}
