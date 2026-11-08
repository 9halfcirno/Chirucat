import fs from "node:fs";
import path from "node:path";
import type { Bot } from "../../bot/bot";
import type { CommandManager } from "../../command/manager";
import type { Core } from "../../core";
import { StateError } from "../../errors/state-error";
import type { BotEventMeta, BotEvents } from "../../protocols/events";
import { root } from "../../utils/root";
import { EventAPI, type EventObserverEntry } from "../contexts/apis/event";
import type {
	PluginEventAPI,
	PluginEventFilter,
	PluginHookAPI,
} from "../contexts/types";
import type { PluginExports } from "../exports";
import { ManagedContextBase } from "../managed-context";
import { BotAPI } from "./apis/bot";
import {
	createProfileAPI,
	createSessionAPI,
	createStatisticsAPI,
	createUserAPI,
	type ProfileAPI,
	type SessionAPI,
	type StatisticsAPI,
	type UserAPI,
} from "./apis/facilities";
import { HooksAPI } from "./apis/hooks";
import { ServiceAPI } from "./apis/service";
import { WebUIAPI } from "./apis/webui";
import type { Service } from "./service";

/**
 * 服务插件运行上下文
 *
 * 形状与其他上下文一致: 能力直接挂在 ctx 上, 没有 `core` 这一层嵌套。
 * 日志、消息回调、平台事件订阅、指令登记、配置与 KV 生命周期、释放流程都在
 * `ManagedContextBase`; 这里只放服务插件独有的部分 —— 全局作用域的事件过滤/Hook、
 * 框架设施视图, 以及全局静态资源挂载。
 *
 * - `command` 注册进全局指令表, 由 Bot 收到消息后转发匹配(见 MessageHandler);
 * - `message` 注册的全局回调同样经 Bot 转发;
 * - 数据目录独立于 Bot: `data/services/<插件id>`;
 * - `user` / `session` / `profile` / `statistics` / `bots` / `services` / `webui`
 *   是框架设施的入口。services/ 属于框架级可信代码, 读写都开放, 但入口是**普通
 *   包装对象**(见 `apis/facilities.ts`): 只列出业务方法, `init` / `close` /
 *   `settings` / `internalDB` 这类启动与释放流程根本不在对象上。
 *
 * 不提供 Bot 维度 API(action / 当前 Bot 视图等): 服务插件不属于任何 Bot,
 * 给了也只能是假的。
 */
export class ServiceContext extends ManagedContextBase {
	/** 框架核心实例; `#core` 是真私有字段, 运行期也拿不到(交付给插件的是下面的包装对象) */
	readonly #core: Core;

	/** 用户标识视图: 查询、绑定关系与列表 */
	readonly user: UserAPI;
	/** 会话标识视图: 查询、绑定关系与成员 */
	readonly session: SessionAPI;
	/** 用户档案视图: 昵称等展示信息 */
	readonly profile: ProfileAPI;
	/** Bot 注册表: 只读快照与启停 */
	readonly bots: BotAPI;
	/** 服务插件注册表: 只读快照 */
	readonly services: ServiceAPI;
	/** 统计查询视图的实现; 对外经 getter 按模块启停决定给不给 */
	readonly #statisticsAPI: StatisticsAPI;
	/** WebUI 注册入口的实现; 懒建, 未启用 WebUI 时 getter 返回 null */
	#webuiAPI: WebUIAPI | null = null;

	/** 事件过滤器与观察回调: 作用于事件传播本身, 而非消息处理 */
	event: PluginEventAPI;
	/** Hook 注册入口: 作用于框架内部流程节点(消息/指令/启停), 可取消动作 */
	hook: PluginHookAPI;

	/** 事件过滤器与观察回调 (释放时清空) */
	private _filters: PluginEventFilter[] = [];
	private _observers: EventObserverEntry[] = [];

	/** 本上下文注册的 Hook 注销函数 (释放时统一调用) */
	private _hookDisposers: Array<() => void> = [];

	/** 本上下文注册的 WebUI 路由与页面注销函数 (释放时统一注销) */
	private _webuiDisposers: (() => void)[] = [];

	/** 本上下文在额外键名下导出的条目 (释放时统一注销) */
	private _provideIds = new Set<string>();

	/** 本上下文挂载的插件静态目录注销函数 (释放时注销) */
	private _unmountPublic: (() => void) | null = null;

	constructor(
		service: Service,
		serviceExports: PluginExports,
		commandManager: CommandManager,
	) {
		super({
			manifest: service.manifest,
			loggerName: "Service",
			storageRoot: path.resolve(root, "data", "services", service.manifest.id),
			config: service.config,
			// 服务插件的导出表只有一张: 既是自己的 `exports`, 也是 `ctx.service` 的来源
			ownExports: serviceExports,
			serviceExports,
			commands: commandManager,
			cron: () => service.core.cron,
		});
		this.#core = service.core;

		// 设施视图只做委托: 每次调用才解析实例, 因此插件可以安全地把它存下来
		// (`const u = ctx.user`), 不必为了"视图不能缓存"写 getter。
		this.user = createUserAPI(() => this.facility(this.#core.user, "user"));
		this.session = createSessionAPI(() => this.facility(this.#core.session, "session"));
		this.profile = createProfileAPI(() => this.facility(this.#core.profile, "profile"));
		this.#statisticsAPI = createStatisticsAPI(() => this.facility(this.#core.statistics, "statistics"));
		this.bots = new BotAPI(this.#core.bot);
		this.services = new ServiceAPI(this.#core.services);

		this.event = new EventAPI(
			(filter) => { this._filters.push(filter); },
			(observer) => { this._observers.push(observer); },
		);
		this.hook = new HooksAPI(this.#core.hooks, (dispose) => {
			this._hookDisposers.push(dispose);
		});

		this.mountServicePublic(service);
	}

	/**
	 * WebUI 注册入口; 未启用 WebUI 时为 null
	 *
	 * 只开放注册自己的端点与页面(见 `WebUIAPI`); 注册出的路由/页面由本上下文统一
	 * 注销, 插件在 `unload` 里不用管。头一次访问时创建并缓存 —— 服务器实例在运行期
	 * 不换(换监听是 `relisten`, 不是换对象), Core 释放后这里直接返回 null。
	 */
	get webui(): WebUIAPI | null {
		const server = this.#core.webui;
		if (!server) return null;
		// 注销函数记在上下文里: 服务停了, 它注册的端点与导航入口随 dispose 一起消失
		return (this.#webuiAPI ??= new WebUIAPI(server, this._manifest.id, (dispose) => {
			this._webuiDisposers.push(dispose);
		}));
	}

	/**
	 * 统计查询视图; 统计模块未开启(或被设置页关掉)时为 null
	 *
	 * 模块可随设置热开关, 因此每次访问都看一次当前实例, 不缓存"有没有"。
	 */
	get statistics(): StatisticsAPI | null {
		return this.#core.statistics ? this.#statisticsAPI : null;
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

	/**
	 * 挂载插件自带的静态资源目录
	 *
	 * 约定: `services/<插件id>/public` ↔ `/service/<插件id>/public`。由框架在服务
	 * 加载时完成, 插件不必(也无法)自己处理静态文件; 目录不存在就不挂 —— 没有前端
	 * 资源的插件不占这个位置。
	 *
	 * WebUI 未启用时 `Core.webui` 为 null, 直接跳过(过滤等功能不依赖 WebUI);
	 * id 不能用作路径段这类配置问题只记日志, 不拖垮整个服务插件。
	 */
	private mountServicePublic(service: Service) {
		const server = service.core.webui;
		if (!server) return;

		const dir = path.resolve(this._manifest.path, "public");
		if (!fs.existsSync(dir)) return;

		try {
			this._unmountPublic = server.mountServicePublic(this._manifest.id, dir);
		} catch (e) {
			this.logger.warn(`挂载插件静态目录失败 (${dir}): ${e instanceof Error ? e.message : e}`);
		}
	}

	/**
	 * 导入其他服务插件的导出
	 *
	 * 每次调用实时查询注册表, 因此不要缓存返回值 ——
	 * 目标服务卸载后其导出即被释放, 缓存下来只会拿到已失效的对象。
	 * @param id 导入的服务插件id
	 * @throws 目标服务当前没有导出(未加载/未导出/已卸载)时抛出 StateError
	 */
	require<T = any>(id: string): T {
		if (this._ownExports.hasExports(id)) {
			return this._ownExports.getExports(id) as T;
		}
		const available = this._ownExports.ids();
		throw new StateError(
			`服务插件 ${this._manifest.id} 导入失败: 服务插件 ${id} 当前没有导出` +
			(available.length ? `(当前可导入: ${available.join(", ")})` : "(当前没有任何服务插件提供导出)")
		);
	}

	/**
	 * 导出服务插件的对象, 供外部调用
	 *
	 * 与 `exports` 的差别只在键名: `exports` 用本插件 id, 这里可用任意键
	 * (如 `"permission"` / `"filter"`), 方便消费方按能力而不是按插件名取用。
	 * @param key 服务的键名
	 * @param service 导出的对象, 供外部使用的接口
	 */
	provide(key: string, service: unknown) {
		this.assertAlive("注入服务");
		this._provideIds.add(key);
		this._ownExports.setExports(key, service, this);
	}

	/**
	 * 过滤事件: 任一过滤器返回 false 即拦截
	 *
	 * 拦截是显式意图, 因此过滤器抛错时按放行处理并记录日志 —— 不能让一个
	 * 出错的过滤器使事件无声消失。
	 * @param event 适配器派发的原始事件
	 * @param bot 收到事件的 Bot
	 * @param meta 事件来源元数据(适配器 id / Bot id)
	 * @returns 是否放行
	 */
	filterEvent(event: BotEvents, bot: Bot, meta: BotEventMeta): boolean {
		if (this._disposed) return true;

		for (const filter of this._filters) {
			try {
				if (!filter(event, bot, meta)) return false;
			} catch (e) {
				this.logger.error("Service event filter error:", e);
			}
		}
		return true;
	}

	/**
	 * 通知本服务插件的事件观察回调: 错误不阻断后续, 期约不等待
	 * @param event 适配器派发的原始事件
	 * @param bot 收到事件的 Bot
	 * @param meta 事件来源元数据(适配器 id / Bot id)
	 * @param accepted 该事件是否通过了全部过滤器
	 */
	observeEvent(event: BotEvents, bot: Bot, meta: BotEventMeta, accepted: boolean) {
		if (this._disposed) return;

		for (const observer of this._observers) {
			// 默认只在事件真的会进入处理链时观察; 声明了 includeFiltered 的才能看到被拦的
			if (!accepted && !observer.includeFiltered) continue;

			try {
				const result = observer.handler(event, bot, meta, accepted);
				if (result instanceof Promise) {
					// 期约同步抛出, 不等待; 仅吞掉 rejection 防止 unhandledRejection
					result.catch((e) => this.logger.error("Service event observer error:", e));
				}
			} catch (e) {
				this.logger.error("Service event observer error:", e);
			}
		}
	}

	/**
	 * 取指定 Bot 上某适配器发布的逃生舱导出(与 `Entity.escape` 同一注册表)
	 *
	 * 服务插件拿不到 Bot 实例(见 `ctx.bots` 快照边界), 这里只交出发布值本身。
	 * 每次调用实时查询, **不要缓存返回值**; Bot/适配器不存在或未发布返回 null。
	 * @param botId 目标 Bot id(平台原生事件的 `meta.bot`)
	 * @param adapterId 适配器插件id(平台原生事件的 `meta.adapter`)
	 */
	adapterEscape<T = any>(botId: string, adapterId: string): T | null {
		const bot = this.#core.bot.bots.get(botId);
		if (!bot) return null;
		return bot.adapterExports.getExports(adapterId) ?? null;
	}

	/**
	 * 释放服务插件独有的资源
	 *
	 * 导出放在最前: 后续清理即便失败, 也不会让导出残留在注册表里。
	 * 公共资源(指令 / 消息回调 / 平台事件订阅 / Cron / 配置 / KV)由基类接手。
	 */
	protected releaseOwned(): void {
		// 归属校验为当前上下文, 不会误删重新加载后的新条目
		this._ownExports.releaseExports(this._manifest.id, this);
		for (const key of this._provideIds) {
			this._ownExports.releaseExports(key, this);
		}

		// 注销本上下文注册的 Hook: 不注销会让已卸载的服务继续干涉框架流程
		for (const disposer of this._hookDisposers) {
			try {
				disposer();
			} catch (e) {
				this.logger.error("Service context dispose: 注销 Hook 失败:", e);
			}
		}
		this._hookDisposers = [];

		// 注销本上下文注册的 WebUI 路由与页面: 之后该路径返回 503(服务未启用)而不是 404,
		// 页面则从导航清单里消失(前端下一次对账就会摘掉它)
		for (const disposeWebUI of this._webuiDisposers) {
			try {
				disposeWebUI();
			} catch (e) {
				this.logger.error("Service context dispose: 注销 WebUI 路由/页面失败:", e);
			}
		}
		this._webuiDisposers = [];

		// 注销插件静态目录挂载: 服务停了, 它的前端资源也不再对外提供
		try {
			this._unmountPublic?.();
		} catch (e) {
			this.logger.error("Service context dispose: 注销插件静态目录失败:", e);
		}
		this._unmountPublic = null;

		this._filters = [];
		this._observers = [];
	}
}
