import fs from "node:fs";
import path from "node:path";
import type { Bot } from "../../bot/bot";
import type { CommandManager } from "../../command/manager";
import type { Command } from "../../command/types";
import { Message } from "../../entity/message";
import { StateError } from "../../errors/state-error";
import type { BotEvents } from "../../protocols/events";
import Logger from "../../utils/logger";
import { root } from "../../utils/root";
import type { PluginExports } from "../exports";
import { PluginConfig } from "../contexts/apis/config";
import { EventAPI } from "../contexts/apis/event";
import { FileSystemAPI } from "../contexts/apis/fs";
import { KVStore } from "../contexts/apis/kv";
import { MessageAPI } from "../contexts/apis/message";
import type {
	MessageCallbackEntry,
	PluginCommandAPI,
	PluginConfigAPI,
	PluginEventAPI,
	PluginEventFilter,
	PluginEventObserver,
	PluginFileSystemAPI,
	PluginKVAPI,
	PluginMessageAPI,
	ReadonlyFsAPI,
} from "../contexts/types";
import type { PluginManifest } from "../types";
import { CoreAPI } from "./apis/core";
import type { Service } from "./service";

/**
 * 服务插件运行上下文
 *
 * 与 `PluginContext` 的公共能力(message / command / fs / kv / config / exports)保持一致,
 * 但作用域是全局而非某个 Bot:
 *
 * - `command` 注册进全局指令表, 由 Bot 收到消息后转发匹配(见 MessageHandler);
 * - `message` 注册的全局回调同样经 Bot 转发;
 * - 数据目录独立于 Bot: `data/services/<插件id>`;
 * - `core` 是收窄过的核心视图(见 `CoreAPI`): services/ 里的代码属于框架级可信插件,
 *   需要拿到用户/会话/统计等全局设施与 Bot 启停, 但拿不到 `Core` 实例本身 ——
 *   `init` / `close` / `settings` 这类启动与释放流程不外放。普通插件没有这个入口,
 *   仍只能通过 Bot 只读视图访问。该视图的 `webui` 还允许服务插件在运行期注册自己的
 *   HTTP 端点(`core.webui.register`), 注册产生的注销由本上下文在释放时代管。
 *
 * 不提供 message/command 之外的 Bot 维度 API(action / 当前 Bot 视图等):
 * 服务插件不属于任何 Bot, 给了也只能是假的。
 */
export class ServiceContext {
	protected _manifest: PluginManifest;

	/** 框架核心的安全视图; 服务插件为可信插件, 拿到收窄后的设施入口 */
	readonly core: CoreAPI;

	logger: Logger;
	message: PluginMessageAPI;
	/** 事件过滤器与观察回调: 作用于事件传播本身, 而非消息处理 */
	event: PluginEventAPI;
	fs: PluginFileSystemAPI;
	/** 插件代码根目录的只读文件访问 */
	plugin: ReadonlyFsAPI;
	kv: PluginKVAPI;
	/** 插件配置(只读), 未声明 manifest.config 时为空配置 */
	config: PluginConfigAPI;
	/** 插件相关路径 */
	path: {
		/** 插件代码根目录 */
		plugin: string;
		/** 插件数据根目录: data/services/<插件id> */
		data: string;
	};

	/** 内部持有的配置视图, 供 dispose 注销监听 */
	private _config: PluginConfig;
	/** 内部持有的 KV 存储实例, 供 dispose 关闭连接 */
	private _kv: KVStore;

	private _onMessageCallback: MessageCallbackEntry[] = [];

	/** 事件过滤器与观察回调 (dispose 时清空) */
	private _filters: PluginEventFilter[] = [];
	private _observers: PluginEventObserver[] = [];

	private _commands = new Set<Command>();

	/** 本上下文注册的 WebUI 路由与页面注销函数 (dispose 时统一注销) */
	private _webuiDisposers: (() => void)[] = [];

	/** 本上下文挂载的插件静态目录注销函数 (dispose 时注销) */
	private _unmountPublic: (() => void) | null = null;

	/** dispose 幂等标记: enable失败/卸载/注册表丢弃都可能重复触发释放 */
	protected _disposed = false;

	constructor(
		service: Service,
		private readonly _serviceExports: PluginExports,
		private readonly _commandManager: CommandManager,
	) {
		// WebUI 路由与页面的注销函数记在上下文里: 插件在 init 里注册后不用自己记住,
		// 卸载时统一注销, 避免"服务停了端点还活着/导航里还留着它注册的页面"
		this.core = new CoreAPI(service.core, service.id, (dispose) => {
			this._webuiDisposers.push(dispose);
		});
		this._manifest = service.manifest;

		this.logger = new Logger(`Service ${this._manifest.id}`);
		this.message = new MessageAPI((entry) => {
			this._onMessageCallback.push(entry);
		});
		this.event = new EventAPI(
			(filter) => { this._filters.push(filter); },
			(observer) => { this._observers.push(observer); },
		);

		const storageRoot = path.resolve(root, "data", "services", this._manifest.id);
		this.fs = new FileSystemAPI(storageRoot);
		// 插件代码目录只读: 允许读自带资源, 不允许改写安装目录
		this.plugin = new FileSystemAPI(path.resolve(root, this._manifest.path), { writable: false });
		this._kv = new KVStore(path.join(storageRoot, ".kv.db"));
		this.kv = this._kv;
		this._config = new PluginConfig(service.config);
		this.config = this._config;

		this.path = {
			plugin: this._manifest.path,
			data: storageRoot
		};

		this.mountServicePublic(service);
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

	/** 全局指令: 注册进 ServiceHost 的共享指令表, 由各个 Bot 的消息处理转发匹配 */
	command: PluginCommandAPI = {
		register: (name, handler) => {
			this.assertAlive("注册指令");
			const command: Command = { name, handler };

			this._commands.add(command);
			this._commandManager.register(command);
			return command;
		},
		unregister: (command) => {
			this._commands.delete(command);
			this._commandManager.unregister(command);
		},
		exec: (message: Message | string, args?: (string | number)[]) => {
			this.assertAlive("触发指令");
			return message instanceof Message ? this._commandManager.exec(message) : this._commandManager.exec(message, args || []);
		}
	}

	/**
	 * 导入其他服务插件的导出
	 *
	 * 每次调用实时查询注册表, 因此不要缓存返回值 ——
	 * 目标服务卸载后其导出即被释放, 缓存下来只会拿到已失效的对象。
	 * @param serviceId 导入的服务插件id
	 * @throws 目标服务当前没有导出(未加载/未导出/已卸载)时抛出 StateError
	 */
	require<T = any>(serviceId: string): T {
		if (this._serviceExports.hasExports(serviceId)) {
			return this._serviceExports.getExports(serviceId) as T;
		}
		const available = this._serviceExports.ids();
		throw new StateError(
			`服务插件 ${this._manifest.id} 导入失败: 服务插件 ${serviceId} 当前没有导出` +
			(available.length ? `(当前可导入: ${available.join(", ")})` : "(当前没有任何服务插件提供导出)")
		);
	}

	/** 对外暴露的导出, 供其他服务插件通过 require 获取 */
	set exports(value: any) {
		this._serviceExports.setExports(this._manifest.id, value, this);
	}

	get exports(): any {
		return this._serviceExports.getExports(this._manifest.id);
	}

	/**
	 * 过滤事件: 任一过滤器返回 false 即拦截
	 *
	 * 拦截是显式意图, 因此过滤器抛错时按放行处理并记录日志 —— 不能让一个
	 * 出错的过滤器使事件无声消失。
	 * @param event 适配器派发的原始事件
	 * @param bot 收到事件的 Bot
	 * @returns 是否放行
	 */
	filterEvent(event: BotEvents, bot: Bot): boolean {
		if (this._disposed) return true;

		for (const filter of this._filters) {
			try {
				if (!filter(event, bot)) return false;
			} catch (e) {
				this.logger.error("Service event filter error:", e);
			}
		}
		return true;
	}

	/**
	 * 通知本服务插件的事件观察回调: 错误不阻断后续, 期约不等待
	 * @param event 已通过过滤的事件
	 * @param bot 收到事件的 Bot
	 */
	observeEvent(event: BotEvents, bot: Bot) {
		if (this._disposed) return;

		for (const observer of this._observers) {
			try {
				const result = observer(event, bot);
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
	 * 触发本服务插件的全局消息回调: 按注册顺序依次匹配, 错误不阻断后续, 期约不等待
	 * @param msg 框架消息
	 */
	handleMessage(msg: Message) {
		if (this._disposed) return;

		for (const entry of this._onMessageCallback) {
			try {
				if (!entry.matcher(msg)) continue;
				const result = entry.handler(msg);
				if (result instanceof Promise) {
					// 期约同步抛出, 不等待; 仅吞掉 rejection 防止 unhandledRejection
					result.catch((e) => this.logger.error("Service message callback error:", e));
				}
			} catch (e) {
				this.logger.error("Service message callback error:", e);
			}
		}
	}

	/**
	 * 断言上下文仍可用
	 * @param action 被拒绝的操作名, 用于报错
	 * @throws 上下文已释放时抛出 StateError
	 */
	protected assertAlive(action: string): void {
		if (this._disposed) throw new StateError(`Context已释放, 无法${action}`);
	}

	/**
	 * 清理服务插件副作用(含对外导出)
	 *
	 * 幂等: enable 失败 / 卸载 / 注册表丢弃都会调用它。
	 * 释放导出放在最前, 后续清理即便失败也不会让导出残留在注册表里。
	 */
	dispose() {
		if (this._disposed) return;
		this._disposed = true;

		// 释放本服务插件导出(归属校验为当前上下文, 不会误删重新加载后的新条目)
		this._serviceExports.releaseExports(this._manifest.id, this);

		this._onMessageCallback = []; // 置空;
		this._filters = [];
		this._observers = [];
		// 清理全局指令
		for (const com of this._commands.values()) {
			this._commandManager.unregister(com)
		}
		this._commands.clear();
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
		// 注销配置变更监听
		this._config.dispose();
		// 关闭 KV 连接(插件可能从未使用 KV, 未初始化时不应视为异常);
		// 清理异常不应阻断上下文释放
		try {
			this._kv.close();
		} catch (e) {
			this.logger.error("Service context dispose: 关闭 KV 失败:", e);
		}
	}
}
