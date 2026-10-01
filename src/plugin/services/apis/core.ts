import type { Core } from "../../../core";
import { StateError } from "../../../errors/state-error";
import type { SessionManager } from "../../../internal/session-manager";
import type { UserManager } from "../../../internal/user-manager";
import type { UserProfileManager } from "../../../internal/user-profile";
import type { StatisticsManager } from "../../../statistics/manager";
import { BotAPI } from "./bot";
import { ServiceAPI } from "./service";
import { WebUIAPI } from "./webui";

/**
 * 设施视图: 只放行白名单里的成员
 *
 * 白名单是**同一份**键列表: 类型上是 `Pick<T, K>`, 运行时是同一份列表做的代理 ——
 * 不存在"类型摘掉了、`as any` 又拿回来"的缝。未列入的成员读到 undefined、赋值直接
 * 失败, 方法绑定到原实例, 视图自身只读。
 *
 * 视图每次访问都新建: 它是轻量代理, 不值得缓存; 缓存下来反而会让 Core 释放之后
 * 仍拿着旧的管理器(见 `CoreAPI` 的 facility 说明)。
 */
function view<T extends object, K extends keyof T>(target: T, keys: readonly K[]): Pick<T, K> {
	const allowed = new Set<PropertyKey>(keys as readonly PropertyKey[]);
	return new Proxy(target, {
		get(t, prop, receiver) {
			if (!allowed.has(prop)) return undefined;
			const value = Reflect.get(t, prop, receiver);
			return typeof value === "function" ? value.bind(t) : value;
		},
		set: () => false,
	}) as Pick<T, K>;
}

/**
 * 用户标识视图的成员白名单
 *
 * 摘掉建表入口 `init` 与连接句柄 `db`(后者本就不在方法白名单里, 类型上是 `Pick`,
 * 不再靠 `Omit` 的键名匹配); 业务方法(查询与绑定关系)原样可用。
 */
export const USER_KEYS = [
	"find", "query", "queryMany", "has", "get", "getUnion", "getLast",
	"bind", "unbind", "restore", "listMembers", "list", "overview",
] as const;
export type UserAPI = Pick<UserManager, (typeof USER_KEYS)[number]>;

/** 会话标识视图的成员白名单: 同样摘掉 `init` */
export const SESSION_KEYS = ["get", "find", "has", "query", "queryMany"] as const;
export type SessionAPI = Pick<SessionManager, (typeof SESSION_KEYS)[number]>;

/** 用户档案视图的成员白名单: 同样摘掉 `init` */
export const PROFILE_KEYS = ["touch", "get", "getMany"] as const;
export type ProfileAPI = Pick<UserProfileManager, (typeof PROFILE_KEYS)[number]>;

/**
 * 统计查询视图的成员白名单
 *
 * 只留查询面。`record` / `recordSend` / `flush` / `close` / `updateOptions` 是
 * 采集与生命周期入口, 由框架在消息链路上自己调用, 放给插件只会干扰统计口径。
 */
export const STATISTICS_KEYS = [
	"summary", "timeline", "rank", "commands", "bots", "userActivity",
] as const;
export type StatisticsAPI = Pick<StatisticsManager, (typeof STATISTICS_KEYS)[number]>;

/**
 * 服务插件视角的框架核心
 *
 * 服务插件不属于任何 Bot, 需要的是全局设施, 但它拿到的不该是 `Core` 实例本身:
 * `init` / `close` / `settings` / `internalDB` 都是框架的启动与释放流程, 插件调一次
 * 就能把整个进程带偏。因此这里只聚合**已经收窄过**的视图:
 *
 * - `bot` / `service`: 只读快照 + 被认可的动作(Bot 启停), 管理器本体不外放;
 * - `webui`: WebUI 视图, 未启用时为 null;
 * - `user` / `session` / `profile` / `statistics`: 全局数据设施的视图,
 *   白名单同时约束类型与运行时。
 *
 * `filterList` 曾在这里, 已随黑白名单能力一起抽离为独立服务插件(`services/filter`):
 * 名单的存储、判定与 WebUI 端点都归它, `ctx.core` 不再提供名单入口。
 *
 * 持有 `Core` 的字段是 `#core`(ECMAScript 私有): 类型上的收窄之外, 运行时也拿不到
 * 这个实例 —— 否则一段 `as any` 就能绕回 `Core.init()`。
 *
 * 数据设施随 `Core.init` 建立, 服务插件加载时必然就绪; 但按次向 Core 取而不是构造时
 * 快照 —— `Core.close` 会把它们置空, 快照下来只会让插件拿着一个已失效的引用继续用。
 * 取不到时抛 StateError, 而不是把已释放的东西当真给出去。
 */
export class CoreAPI {
	readonly bot: BotAPI;
	readonly service: ServiceAPI;

	readonly #core: Core;
	/** 归属的服务插件 id (WebUI 端点注册与错误信息要用) */
	readonly #serviceId: string;
	/** 记录 WebUI 路由注销函数: 上下文释放时统一注销, 插件不必自己记住 */
	readonly #trackWebUIRoute: ((dispose: () => void) => void) | undefined;

	constructor(core: Core, serviceId: string, trackWebUIRoute?: (dispose: () => void) => void) {
		this.#core = core;
		this.#serviceId = serviceId;
		this.#trackWebUIRoute = trackWebUIRoute;

		this.bot = new BotAPI(core.bot);
		this.service = new ServiceAPI(core.services);
	}

	/**
	 * WebUI 视图; 未启用 WebUI 时为 null
	 *
	 * 只开放注册自己的端点(见 `WebUIAPI.register`); 注册出的路由由上下文统一注销,
	 * 因此插件自己在 `unload` 里不用管它。
	 */
	get webui(): WebUIAPI | null {
		const server = this.#core.webui;
		// 视图每次新建, 不缓存: 换监听/关闭后插件读到的必须是最新事实
		return server ? new WebUIAPI(server, this.#serviceId, this.#trackWebUIRoute) : null;
	}

	/** 用户标识视图 */
	get user(): UserAPI {
		return view(this.facility(this.#core.user, "user"), USER_KEYS);
	}

	/** 会话标识视图 */
	get session(): SessionAPI {
		return view(this.facility(this.#core.session, "session"), SESSION_KEYS);
	}

	/** 用户档案视图 */
	get profile(): ProfileAPI {
		return view(this.facility(this.#core.profile, "profile"), PROFILE_KEYS);
	}

	/**
	 * 统计查询视图
	 *
	 * 统计模块可被设置热开关, 关掉时实例被释放 —— 未开启时为 null,
	 * 因此这里不做"必然就绪"的断言(与上面几个设施不同)。
	 */
	get statistics(): StatisticsAPI | null {
		const statistics = this.#core.statistics;
		return statistics ? view(statistics, STATISTICS_KEYS) : null;
	}

	/**
	 * 取一个随 Core.init 建立的设施
	 * @param value 设施实例; Core 尚未初始化或已释放时为 null
	 * @param name 设施名, 用于报错
	 * @throws 设施不可用时抛出 StateError
	 */
	private facility<T>(value: T | null, name: string): T {
		if (!value) throw new StateError(`Core 的 ${name} 设施不可用(尚未初始化或已释放)`);
		return value;
	}
}
