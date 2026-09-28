import type { Core } from "../../core";
import type { ConfigManager } from "../../config/manager";
import type { ConfigRoot } from "../../config/types";
import { StateError } from "../../errors/state-error";
import Logger from "../../utils/logger";
import type { PluginManifest, PluginModule, PluginStatus } from "../types";
import type { ServiceContext } from "./context";

/**
 * 服务插件模块: 与 PluginModule 同构, 上下文换成 ServiceContext
 *
 * 模块契约(init / unload / error)与普通插件完全一致, 差异只在拿到什么上下文。
 */
export type ServiceModule = PluginModule<ServiceContext>;

/**
 * 服务插件实例
 *
 * 与 `Plugin` 的状态机、生命周期钩子语义保持一致(注册 / 加载中 / 启用 / 卸载中 / 禁用,
 * 加载失败回落到加载前的关态), 区别只在于宿主: `Plugin` 属于某个 Bot, 每个 Bot 各持一份;
 * `Service` 属于整个框架, 由 `ServiceHost` 在 Core 上持有唯一实例。
 *
 * 正因如此它不持有 Bot —— 服务插件的作用域是全局的, 拿不到也不该拿到"某一个 Bot"。
 */
export type ServiceOption = {
	manifest: PluginManifest;
	core: Core;
	/** 插件模块, 由 ServiceHost.load 加载后填充 */
	module?: ServiceModule;
	/** 插件运行上下文 */
	context?: ServiceContext;
};

export class Service {
	logger: Logger;

	/** 运行状态 */
	status: PluginStatus = "registered";

	/** 同清单 id */
	id: string;
	manifest: PluginManifest;
	core: Core;

	/** 服务插件配置schema (定义文件里的控件定义), 未声明 manifest.config 时为 null */
	configSchema: null | ConfigRoot = null;

	/** 服务插件配置(值)管理器; 未声明 manifest.config 或装配失败时为 null */
	config: ConfigManager | null = null;

	module: ServiceModule | null = null;
	context: ServiceContext | null = null;

	constructor(option: ServiceOption) {
		this.manifest = option.manifest;
		this.id = option.manifest.id;
		this.core = option.core;
		this.logger = new Logger(`Service ${this.id}`);
		option.context && (this.context = option.context);
		option.module && (this.module = option.module);
	}

	/**
	 * 启动服务插件, 执行 module.init 方法
	 *
	 * 成功进入 enabled; 失败时只做资源清理(调用 error 钩子并释放上下文),
	 * 终态留给调用方 —— ServiceHost.load 会把服务恢复到加载前的关态,
	 * 失败原因靠抛出的异常上报, 不占用独立状态。
	 * @param ctx 运行上下文, 由 ServiceHost 创建
	 */
	async enable(ctx?: ServiceContext) {
		if (this.status === "enabled") return; // 幂等
		// loading 是合法入态: ServiceHost.load 已前置, 直接进入
		if (this.status === "unloading") throw new StateError(`服务插件 ${this.id} 正在切换状态, 请稍后再试`)
		if (!this.module) throw new Error(`服务插件 ${this.id} 模块未加载`);
		if (ctx === undefined && this.context === null) {
			throw new Error(`服务插件 ${this.id} 无运行上下文`)
		}
		ctx && (this.context = ctx);
		if (this.status !== "loading") this.status = "loading";
		try {
			await this.module.init(this.context!);
			this.status = "enabled";
		} catch (e) {
			// 让插件尝试清理初始化到一半的资源(error 钩子相当于插件自己的 try/catch)
			try {
				await this.module.error?.(e);
			} catch (e) {
				this.logger.error(`服务插件载入时错误清理失败`, e)
			}
			this.context?.dispose?.();
			this.context = null; // 上下文已释放, 断开引用避免后续误用
			throw e; // 终态由调用方恢复: 加载失败对外就是"没开起来", 不留第三种状态
		}
	}

	/**
	 * 卸载服务插件: 释放模块与上下文, 保留注册表条目
	 * @param [destroy=false] 销毁插件模块, 使 ServiceHost.load 触发再次加载, 默认不销毁
	 */
	async disable(destroy: boolean = false) {
		if (this.status === "disabled" || this.status === "registered") return; // 幂等
		if (this.status === "loading" || this.status === "unloading") throw new StateError(`服务插件 ${this.id} 正在切换状态, 请稍后再试`)

		this.status = "unloading";
		try {
			// context 缺失说明插件从未成功启用(init 失败时已由 error 钩子清理过), 跳过 unload
			const ctx = this.context;
			if (this.module?.unload && ctx) await this.module.unload(ctx);
		} catch (e) {
			// unload 失败也让插件尝试清理
			try {
				await this.module?.error?.(e);
			} catch (e) {
				this.logger.error(`服务插件卸载时错误清理失败`, e)
			}
		}
		this.context?.dispose();
		this.context = null; // 上下文已释放, 断开引用避免后续误用
		destroy && (this.module = null);
		this.configSchema = null; // 同时卸载配置项
		this.config = null;
		this.status = "disabled";
	}
}
