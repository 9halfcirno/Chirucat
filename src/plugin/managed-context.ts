/**
 * 插件与服务插件共通的运行上下文骨架
 *
 * `PluginContext`(每个 Bot 一份) 与 `ServiceContext`(全局单例) 的日志、消息回调、
 * 平台事件订阅、指令登记、配置与 KV 生命周期、跨重载暂存、释放流程逐行同构, 差异只有构造参数
 * (数据目录、指令表、导出注册表、Cron 来源) 与少数域能力。
 *
 * 与 `ManagedEntity` / `ManagedHostBase` 同一套做法: 共通部分固定在基类, 差异由
 * 构造选项显式给出, 基类里没有布尔开关。
 *
 * 刻意留在子类的域能力:
 * - `PluginContext`: `bot` / `user` / `session` / `action` / `require` / `adapterEscape`
 * - `ServiceContext`: 事件过滤与观察、Hook、框架设施视图、`provide` / `require`
 *
 * 释放顺序是固定的: 先释放本上下文独有的资源(导出 / Hook / WebUI 注册), 再注销指令、
 * 等待 Cron 收尾, 最后关配置监听与 KV 连接 —— 顺序反了会留下"指令还在、KV 已关"
 * 这类悬空引用。
 */
import path from "node:path";
import type { CommandManager } from "../command/manager";
import type { Command } from "../command/types";
import type { ConfigManager } from "../config/manager";
import { Message } from "../entity/message";
import { StateError } from "../errors/state-error";
import type { BotEventMeta } from "../protocols/events";
import type { CronManager } from "../utils/cron-manager";
import Logger from "../utils/logger";
import { root } from "../utils/root";
import { PluginConfig } from "./contexts/apis/config";
import { CronScope } from "./contexts/apis/cron";
import { FileSystemAPI } from "./contexts/apis/fs";
import { KVStore } from "./contexts/apis/kv";
import { MessageAPI } from "./contexts/apis/message";
import { PluginMemory } from "./contexts/apis/memory";
import type {
	MessageCallbackEntry,
	PlatformEventCallback,
	PluginCommandAPI,
	PluginConfigAPI,
	PluginCronAPI,
	PluginFileSystemAPI,
	PluginKVAPI,
	PluginMemoryAPI,
	PluginMessageAPI,
	ReadonlyFsAPI,
} from "./contexts/types";
import type { PluginExports } from "./exports";
import type { PluginManifest } from "./types";

/** 构造共性的显式差异; 不含任何"是不是服务插件"的布尔开关 */
export type ManagedContextOptions = {
	manifest: PluginManifest;
	/** 日志前缀里的主体名: `Plugin` / `Service` */
	loggerName: string;
	/** 日志 tag: 普通插件带 Bot id, 服务插件不需要 */
	tag?: string | undefined;
	/** 数据根目录: `fs` 与 `kv` 的根 */
	storageRoot: string;
	/** 配置值管理器; 未声明配置时为 null */
	config: ConfigManager | null;
	/**
	 * 跨重载暂存的桶, 由宿主的 `memoryFor` 给出
	 *
	 * 与实体不同, 这个桶不随上下文一起重建 —— 插件停用再启用后读到的还是同一份,
	 * 这正是它存在的理由(见 `PluginMemoryAPI`)。
	 */
	memory: Map<string, unknown>;
	/** 本上下文自己的导出注册表 (`exports` / `require` 的操作对象) */
	ownExports: PluginExports;
	/** 其他服务插件的导出注册表 (`ctx.service`); 无则为 null */
	serviceExports: PluginExports | null;
	/** 指令表: 普通插件是本 Bot 的, 服务插件是全局的 */
	commands: CommandManager;
	/** Cron 调度器来源 (Core 释放后可能为 null) */
	cron: () => CronManager | null;
};

export abstract class ManagedContextBase {
	/** 日志与错误文案里的主体名, 如 `Plugin` / `Service` */
	protected readonly _label: string;
	protected _manifest: PluginManifest;
	/** 本上下文自己的导出注册表; 子类的 `require` / `provide` 走它 */
	protected readonly _ownExports: PluginExports;

	/** dispose 幂等标记: enable 失败 / 卸载 / 注册表丢弃都可能重复触发释放 */
	protected _disposed = false;

	logger: Logger;
	message: PluginMessageAPI;
	fs: PluginFileSystemAPI;
	/** 插件代码根目录的只读文件访问 */
	plugin: ReadonlyFsAPI;
	kv: PluginKVAPI;
	/** 插件配置(只读), 未声明配置时为空配置 */
	config: PluginConfigAPI;
	/** 定时任务: 与其他上下文共用同一套登记与释放规则 */
	cron: PluginCronAPI;
	/** 插件相关路径 */
	path: {
		/** 插件代码根目录 */
		plugin: string;
		/** 插件数据根目录 */
		data: string;
	};
	/** 其他服务插件的导出; 由服务插件注入, 未提供时读到 undefined */
	readonly service: Record<string, unknown>;
	/** 指令登记入口: 普通插件写进本 Bot 的指令表, 服务插件写进全局指令表 */
	readonly command: PluginCommandAPI;
	/** 跨重载暂存: 本插件的内存桶视图(值经复制, 不随上下文重建而清空) */
	readonly memory: PluginMemoryAPI;

	private readonly _commandsRegistry: CommandManager;
	private readonly _serviceExports: PluginExports | null;
	private readonly _config: PluginConfig;
	private readonly _kv: KVStore;
	private readonly _cronScope: CronScope;

	private _onMessageCallback: MessageCallbackEntry[] = [];

	/** 平台原生事件订阅: 适配器插件id -> 回调 (释放时清空) */
	private readonly _platformEventSubs = new Map<string, PlatformEventCallback[]>();

	/** 本上下文注册的指令, 供释放时统一注销 */
	private readonly _commands = new Set<Command>();

	constructor(options: ManagedContextOptions) {
		this._label = options.loggerName;
		this._manifest = options.manifest;
		this._ownExports = options.ownExports;
		this._serviceExports = options.serviceExports;
		this._commandsRegistry = options.commands;

		this.logger = new Logger(
			`${options.loggerName} ${this._manifest.id}`,
			options.tag === undefined ? {} : { tag: options.tag },
		);
		this.message = new MessageAPI((entry) => {
			this._onMessageCallback.push(entry);
		});

		this.fs = new FileSystemAPI(options.storageRoot);
		// 插件代码目录只读: 允许读自带资源, 不允许改写安装目录
		this.plugin = new FileSystemAPI(path.resolve(root, this._manifest.path), { writable: false });
		this._kv = new KVStore(path.join(options.storageRoot, ".kv.db"));
		this.kv = this._kv;
		this.memory = new PluginMemory(options.memory);
		this._config = new PluginConfig(options.config);
		this.config = this._config;
		this._cronScope = new CronScope(
			(action) => this.assertAlive(action),
			options.cron,
		);
		this.cron = this._cronScope;

		this.path = {
			plugin: this._manifest.path,
			data: options.storageRoot,
		};

		// 每次读取实时查询注册表: 目标服务卸载后其导出即被释放
		this.service = new Proxy({}, {
			get: (_, key) => {
				if (typeof key !== "string") return undefined;
				return this._serviceExports?.getExports(key);
			},
		});

		this.command = {
			register: (name, handler, options) => {
				this.assertAlive("注册指令");
				const command: Command = {
					name,
					handler,
					permission: options?.permission ?? 0,
				};

				this._commands.add(command);
				this._commandsRegistry.register(command);
				return command;
			},
			unregister: (command) => {
				this._commands.delete(command);
				this._commandsRegistry.unregister(command);
			},
			exec: (message: Message | string, args?: (string | number)[]) => {
				this.assertAlive("触发指令");
				return message instanceof Message
					? this._commandsRegistry.exec(message)
					: this._commandsRegistry.exec(message, args || []);
			},
		};
	}

	/** 对外暴露的导出, 供依赖本上下文的插件通过 `require` / `ctx.service` 取用 */
	set exports(value: unknown) {
		this.assertAlive("设置导出");
		this._ownExports.setExports(this._manifest.id, value, this);
	}

	get exports(): unknown {
		return this._ownExports.getExports(this._manifest.id);
	}

	/**
	 * 触发本上下文的消息回调: 按注册顺序依次匹配, 错误不阻断后续, 期约不等待
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
					result.catch((e) => this.logger.error(`${this._label} message callback error:`, e));
				}
			} catch (e) {
				this.logger.error(`${this._label} message callback error:`, e);
			}
		}
	}

	/**
	 * 订阅某适配器派发的平台原生事件(逃生舱)
	 *
	 * 只收 `adapterId` 派发的事件; 重复登记同一处理器会被忽略 ——
	 * 适配器重启后重新订阅不会造成重复收流。随上下文释放自动注销。
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
	 * 将平台原生事件投递给订阅了该来源的回调: 错误不阻断后续, 期约不等待
	 * @param event 平台原生事件
	 * @param meta 事件元信息, 携带来源适配器与 Bot id
	 */
	handlePlatformEvent(event: Record<string, any>, meta: BotEventMeta) {
		if (this._disposed) return;

		for (const handler of this._platformEventSubs.get(meta.adapter) ?? []) {
			try {
				const result = handler(event, meta);
				if (result instanceof Promise) {
					result.catch((e) => this.logger.error(`${this._label} platform event callback error:`, e));
				}
			} catch (e) {
				this.logger.error(`${this._label} platform event callback error:`, e);
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
	 * 释放上下文
	 *
	 * 幂等: enable 失败 / 卸载 / 注册表丢弃都会调用它。
	 * 子类独有的资源(导出、Hook、WebUI 注册)先由 `releaseOwned()` 释放 ——
	 * 即使后续清理失败, 导出也不会残留在注册表里。
	 */
	async dispose() {
		if (this._disposed) return;
		this._disposed = true;

		this.releaseOwned();

		this._onMessageCallback = [];
		this._platformEventSubs.clear();
		for (const command of this._commands) {
			this._commandsRegistry.unregister(command);
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
			this.logger.error(`${this._label} context dispose: 关闭 KV 失败:`, e);
		}
	}

	/**
	 * 释放本上下文独有的资源
	 *
	 * 由基类在清理公共资源**之前**调用。实现应逐项 try/catch, 不让单点失败
	 * 阻断后续清理; 公共资源(指令 / Cron / 配置 / KV)由基类接手。
	 */
	protected abstract releaseOwned(): void;
}
