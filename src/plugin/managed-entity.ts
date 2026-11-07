/**
 * 插件与服务插件共通的实体状态机
 *
 * `Plugin`(属于某个 Bot, 每个 Bot 各一份) 与 `Service`(属于整个框架, 全局单例)
 * 的 enable/disable 流程、失败清理、配置与模块生命周期逐行同构, 差异只有四处,
 * 全部由构造选项显式给出, 不在基类里用布尔开关切分支:
 * - 日志前缀(`Plugin` / `Service`)与 tag(普通插件带 Bot id)
 * - 错误文案里的主体名(`插件` / `服务插件`)
 * - 运行上下文与模块的类型(泛型 C / M)
 * - 宿主引用(`bot` / `core`)与 `scope` / `type`: 留在子类, 基类不认识 Core/Bot
 *
 * 状态机的终态分工不变: enable/disable **失败时只做清理**(error 钩子 + 释放上下文),
 * 状态停在 `loading` / `unloading`, 由宿主恢复到加载前的关态。
 */
import type { ConfigManager } from "../config/manager";
import type { ConfigRoot } from "../config/types";
import { StateError } from "../errors/state-error";
import Logger from "../utils/logger";
import type { PluginManifest, PluginModule, PluginStatus } from "./types";

/** 实体对运行上下文的唯一要求: 失败或卸载时能释放 */
export interface DisposableContext {
	dispose(): void | Promise<void>;
}

export interface ManagedEntityOption<C, M> {
	manifest: PluginManifest;
	/** 日志前缀里的主体名, 如 `Plugin` / `Service` */
	loggerName: string;
	/** 错误文案里的主体名, 如 `插件` / `服务插件` */
	label: string;
	/** 日志 tag: 普通插件带 Bot id, 服务插件不需要 */
	tag?: string | undefined;
	module?: M | undefined;
	context?: C | undefined;
}

export class ManagedEntity<
	C extends DisposableContext,
	M extends PluginModule<C>,
> {
	logger: Logger;

	/** 错误文案里的主体名; 宿主也可复用它拼日志 */
	readonly label: string;

	/** 运行状态 */
	status: PluginStatus = "registered";

	/** 同清单 id */
	readonly id: string;
	manifest: PluginManifest;

	/** 配置 schema(定义文件里的控件定义), 未声明 manifest.config 时为 null */
	configSchema: null | ConfigRoot = null;

	/** 配置(值)管理器; 未声明 manifest.config 或装配失败时为 null */
	config: ConfigManager | null = null;

	module: M | null = null;
	context: C | null = null;

	constructor(option: ManagedEntityOption<C, M>) {
		this.manifest = option.manifest;
		this.id = option.manifest.id;
		this.label = option.label;
		this.logger = new Logger(`${option.loggerName} ${this.id}`,
			option.tag === undefined ? {} : { tag: option.tag });
		if (option.context) this.context = option.context;
		if (option.module) this.module = option.module;
	}

	/**
	 * 启动实体, 执行 module.init
	 *
	 * 成功进入 enabled; 失败时只做资源清理(调用 error 钩子并释放上下文),
	 * 终态留给调用方 —— 宿主会把实体恢复到加载前的关态,
	 * 失败原因靠抛出的异常上报, 不占用独立状态。
	 * @param ctx 运行上下文, 由宿主创建
	 */
	async enable(ctx?: C): Promise<void> {
		if (this.status === "enabled") return; // 幂等
		// loading 是合法入态: 宿主已前置, 直接进入
		if (this.status === "unloading") throw new StateError(`${this.label} ${this.id} 正在切换状态, 请稍后再试`)
		if (!this.module) throw new Error(`${this.label} ${this.id} 模块未加载`);
		if (ctx === undefined && this.context === null) {
			throw new Error(`${this.label} ${this.id} 无运行上下文`)
		}
		if (ctx) this.context = ctx;
		if (this.status !== "loading") this.status = "loading";
		try {
			await this.module.init(this.context!);
			this.status = "enabled";
		} catch (e) {
			// 让插件尝试清理初始化到一半的资源(error 钩子相当于插件自己的 try/catch)
			try {
				await this.module.error?.(e);
			} catch (hookError) {
				// 这里报的是 error 钩子自己的失败原因, 不是最初那个 init 错误
				this.logger.error(`${this.label}载入时错误清理失败`, hookError)
			}
			await this.context?.dispose();
			this.context = null; // 上下文已释放, 断开引用避免后续误用
			throw e; // 终态由调用方恢复: 加载失败对外就是"没开起来", 不留第三种状态
		}
	}

	/**
	 * 卸载实体: 释放模块与上下文, 保留注册表条目
	 * @param [destroy=false] 销毁模块, 使宿主 load 触发再次加载, 默认不销毁
	 */
	async disable(destroy: boolean = false): Promise<void> {
		if (this.status === "disabled" || this.status === "registered") return; // 幂等
		if (this.status === "loading" || this.status === "unloading") throw new StateError(`${this.label} ${this.id} 正在切换状态, 请稍后再试`)

		this.status = "unloading";
		try {
			// context 缺失说明从未成功启用(init 失败时已由 error 钩子清理过), 跳过 unload
			const ctx = this.context;
			if (this.module?.unload && ctx) await this.module.unload(ctx);
		} catch (e) {
			// unload 失败也让插件尝试清理
			try {
				await this.module?.error?.(e);
			} catch (hookError) {
				this.logger.error(`${this.label}卸载时错误清理失败`, hookError)
			}
		}
		await this.context?.dispose();
		this.context = null; // 上下文已释放, 断开引用避免后续误用
		if (destroy) this.module = null;
		this.configSchema = null; // 同时卸载配置项
		this.config = null;
		this.status = "disabled";
	}
}
