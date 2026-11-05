import type { Bot } from "../../bot/bot";
import type { Command } from "../../command/types";
import type { Entity } from "../../entity/entity";
import { Message } from "../../entity/message";
import type { BotActions } from "../../protocols/actions";
import type { PluginManifest } from "../types";
import { MessageAPI } from "./apis/message";
import type { MessageCallbackEntry, MessageMatcher, PlatformEventCallback, PluginBotAPI, PluginCommandAPI, PluginConfigAPI, PluginCronAPI, PluginFileSystemAPI, PluginKVAPI, PluginMessageAPI, PluginSessionAPI, PluginUserAPI, ReadonlyFsAPI } from "./types";
import { FileSystemAPI } from "./apis/fs";
import { KVStore } from "./apis/kv";
import { PluginConfig } from "./apis/config";
import path from "node:path";
import { root } from "../../utils/root";
import { PluginExports } from "../exports";
import { StateError } from "../../errors/state-error";
import type { Plugin } from "../plugin";
import Logger from "../../utils/logger";
import { CronScope } from "./apis/cron";
import type { BotEventMeta } from "../../protocols/events";

export class PluginContext {
	protected _bot: Bot;
	protected _manifest: PluginManifest;

	logger: Logger;
	message: PluginMessageAPI;
	fs: PluginFileSystemAPI;
	/** 插件代码根目录的只读文件访问 */
	plugin: ReadonlyFsAPI;
	kv: PluginKVAPI;
	/** 插件配置(只读), 未声明 manifest.config 时为空配置 */
	config: PluginConfigAPI;
	/** 当前 Bot 的只读视图 */
	bot: PluginBotAPI;
	/** 插件相关路径 */
	path: {
		/** 插件代码根目录 */
		plugin: string;
		/** 插件数据根目录: bot/data/plugins/<插件id> */
		data: string;
	};

	/** 内部持有的配置视图, 供 dispose 注销监听 */
	private _config: PluginConfig;
	/** 内部持有的 KV 存储实例, 供 dispose 关闭连接 */
	private _kv: KVStore;

	private _onMessageCallback: MessageCallbackEntry[] = [];

	/** 平台原生事件订阅: 适配器插件id -> 回调; 派发时只投递给订阅了该来源的上下文 */
	private _platformEventSubs = new Map<string, PlatformEventCallback[]>();

	private _commands = new Set<Command>();

	/** dispose 幂等标记: enable失败/卸载/注册表丢弃都可能重复触发释放 */
	protected _disposed = false;

	constructor(
		plugin: Plugin,
		protected _pluginExports: PluginExports,
		/** 服务插件提供的功能 */
		private _serviceExports: PluginExports | null = null,
		/** 适配器逃生舱注册表; 普通插件不发布, 但可经 onPlatformEvent 订阅后按来源取用 */
		protected _adapterExports: PluginExports = new PluginExports(),
	) {
		this._bot = plugin.bot;
		this._manifest = plugin.manifest;

		this.logger = new Logger(`Plugin ${this._manifest.id}`, { tag: this._bot.id });
		this.message = new MessageAPI((entry) => {
			this._onMessageCallback.push(entry);
		});
		// bot.path 为绝对路径, resolve 会从其重置; 若为相对路径则以 root 为基准
		const storageRoot = path.resolve(root, this._bot.path, "data", "plugins", this._manifest.id);
		this.fs = new FileSystemAPI(storageRoot);
		// 插件代码目录只读: 允许读自带资源, 不允许改写安装目录
		this.plugin = new FileSystemAPI(path.resolve(root, this._manifest.path), { writable: false });
		this._kv = new KVStore(path.join(storageRoot, ".kv.db"));
		this.kv = this._kv;
		this._config = new PluginConfig(plugin.config);
		this.config = this._config;

		this.bot = {
			id: this._bot.id,
			name: this._bot.name
		};

		this.path = {
			plugin: this._manifest.path,
			data: storageRoot
		};
	}

	command: PluginCommandAPI = {
		register: (name, handler, options) => {
			this.assertAlive("注册指令");
			const command: Command = {
				name, handler,
				permission: options?.permission ?? 0
			 };

			this._commands.add(command);
			this._bot.command.register(command);
			return command;
		},
		unregister: (command) => {
			this._commands.delete(command);
			this._bot.command.unregister(command);
		},
		exec: (message: Message | string, args?: (string | number)[]) => {
			this.assertAlive("触发指令");
			return message instanceof Message ? this._bot.command.exec(message) : this._bot.command.exec(message, args || []);
		}
	}

	/** 定时任务实现: 持有登记表与等待逻辑, 对外只暴露 PluginCronAPI */
	private readonly _cronScope = new CronScope(
		(action) => this.assertAlive(action),
		() => this._bot.core.cron,
	);

	cron: PluginCronAPI = this._cronScope;

	/** 用户标识: 只查不建, 账号落账由适配器负责 */
	user: PluginUserAPI = {
		find: (platform, id) => {
			return this._bot.core.user!.find(platform, id);
		},
		query: (uuid) => {
			return this._bot.core.user!.query(uuid);
		},
		getUnion: (accountId) => {
			return this._bot.core.user!.getUnion(accountId);
		},
	}

	/** 会话标识: 只查不建, 会话落账由适配器负责 */
	session: PluginSessionAPI = {
		find: (platform, type, id) => {
			return this._bot.core.session!.find(platform, type, id);
		},
		query: (uuid) => {
			return this._bot.core.session!.query(uuid);
		},
	}

	/**
	 * 触发Bot动作
	 * @param entity 事件实体
	 * @param action 动作对象
	 */
	action(entity: Entity, action: BotActions) {
		this.assertAlive("发送Action");
		return this._bot.action(action, entity.meta.adapter, entity.extra)
	}

	/**
	 * 导入bot加载的其他插件的导出
	 *
	 * 每次调用实时查询注册表, 因此不要在插件里缓存返回值 ——
	 * 目标插件卸载后其导出即被释放, 缓存下来只会拿到已失效的对象。
	 * @param pluginId 导入插件的id
	 * @throws 目标插件当前没有导出(未加载/未导出/已卸载)时抛出 StateError
	 */
	require<T = any>(pluginId: string): T {
		if (this._pluginExports.hasExports(pluginId)) {
			return this._pluginExports.getExports(pluginId) as T;
		}

		// 适配器的导出不进 require 注册表: 它发布在逃生舱注册表, 按事件来源取用
		const target = this._bot.plugin.enabledPlugins
			.find(p => p.id === pluginId && p.manifest.type === "adapter");
		if (target) {
			throw new StateError(
				`插件 ${this._manifest.id} 导入失败: 插件 ${pluginId} 是适配器, ` +
				`其导出走逃生舱注册表, 请经 Entity.escape() / ctx.adapterEscape("${pluginId}") 取用, 或订阅 ctx.onPlatformEvent("${pluginId}", ...)`
			);
		}

		const available = [...this._pluginExports.ids()];
		throw new StateError(
			`插件 ${this._manifest.id} 导入失败: 插件 ${pluginId} 当前没有导出` +
			(available.length ? `(当前可导入: ${available.join(", ")})` : "(当前没有任何插件提供导出)")
		);
	}

	/**
	 * 取适配器发布的逃生舱导出(与 `Entity.escape` 同一注册表, 不要求手头有实体)
	 *
	 * 纯平台事件通路(见 `onPlatformEvent`)里消费者只有 `event + meta`,
	 * 用 `ctx.adapterEscape(meta.adapter)` 闭环。每次调用实时查询, 不要缓存返回值 ——
	 * 适配器卸载后条目即被释放。未发布逃生舱时返回 null, 调用方自行降级。
	 * @param adapterId 适配器插件id
	 */
	adapterEscape<T = any>(adapterId: string): T | null {
		return this._adapterExports.getExports(adapterId) ?? null;
	}

	/**
	 * 服务插件的导出，由服务插件注入
	 * 
	 * 本质为对ServiceExports的代理包装，但通常服务插件加载先于其他插件，所以只要用户安装了，就能获取到导出
	 */
	service: Record<string, unknown> = new Proxy({}, {
		get: (_, key) => {
			if (typeof key !== "string") return undefined;
			return this._serviceExports?.getExports(key);
		}
	})

	/** 对外暴露的导出, 供依赖本插件的插件通过 require 获取 */
	set exports(value: any) {
		this.assertAlive("设置插件导出");
		this._pluginExports.setExports(this._manifest.id, value, this);
	}

	get exports(): any {
		return this._pluginExports.getExports(this._manifest.id);
	}

	/**
	 * 触发本插件的消息回调: 按注册顺序依次匹配, 错误不阻断后续, 期约不等待
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
					result.catch((e) => this.logger.error("Plugin message callback error:", e));
				}
			} catch (e) {
				this.logger.error("Plugin message callback error:", e);
			}
		}
	}

	/**
	 * 订阅某适配器派发的平台原生事件(逃生舱)
	 *
	 * 只收 `adapterId` 派发的原生事件; 同一上下文重复登记同一处理器会被忽略,
	 * 避免"适配器重启后重新订阅"造成重复收流。随上下文释放自动注销 ——
	 * 订阅表归框架持有, 适配器卸载/重载不影响订阅者。
	 * @param adapterId 来源适配器插件id
	 * @param handler 事件回调, 返回值不被等待
	 */
	onPlatformEvent(adapterId: string, handler: PlatformEventCallback) {
		this.assertAlive("订阅平台原生事件");
		const entries = this._platformEventSubs.get(adapterId) ?? [];
		if (!entries.includes(handler)) {
			entries.push(handler);
			this._platformEventSubs.set(adapterId, entries);
		}
	}

	/**
	 * 处理平台原生事件(逃生舱通路)
	 * @param event 平台原生事件
	 * @param meta 事件元信息, 如适配器/Bot id
	 */
	handlePlatformEvent(event: Record<string, any>, meta: BotEventMeta) {
		if (this._disposed) return;

		// 只投递给订阅了该来源的上下文; 错误隔离与消息回调一致: 不阻断后续, 期约不等待
		for (const entry of this._platformEventSubs.get(meta.adapter) ?? []) {
			try {
				const result = entry(event, meta);
				if (result instanceof Promise) {
					// 期约同步抛出, 不等待; 仅吞掉 rejection 防止 unhandledRejection
					result.catch((e) => this.logger.error("Plugin platform event callback error:", e));
				}
			} catch (e) {
				this.logger.error("Plugin platform event callback error:", e);
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
	 * 清理插件副作用(含对外导出)
	 *
	 * 幂等: enable 失败 / 卸载 / 注册表丢弃都会调用它。
	 * 释放导出放在最前, 后续清理即便失败也不会让导出残留在注册表里。
	 */
	async dispose() {
		if (this._disposed) return;
		this._disposed = true;

		// 释放本插件导出(归属校验为当前上下文, 不会误删重新加载后的新条目)
		this._pluginExports.releaseExports(this._manifest.id, this);
		// 逃生舱发布走独立注册表(适配器上下文重定向), 普通插件此处通常为空条目, 一并释放不留残余
		this._adapterExports.releaseExports(this._manifest.id, this);

		this._onMessageCallback = []; // 置空;
		this._platformEventSubs.clear(); // 平台事件订阅随上下文释放
		// 清理指令
		for (const com of this._commands.values()) {
			this._bot.command.unregister(com)
		}
		this._commands.clear();

		// 停止本上下文创建的调度, 并等待运行中的 handler 收尾
		await this._cronScope.stopAll(this.logger);

		// 注销配置变更监听
		this._config.dispose();
		// 关闭 KV 连接(插件可能从未使用 KV, 未初始化时不应视为异常);
		// 清理异常不应阻断上下文释放
		try {
			this._kv.close();
		} catch (e) {
			this.logger.error("Plugin context dispose: 关闭 KV 失败:", e);
		}
	}
}
