import type { Bot } from "../bot/bot";
import type { ConfigManager } from "../config/manager";
import type { ConfigRoot } from "../config/types";
import { StateError } from "../errors/state-error";
import Logger from "../utils/logger";
import type { PluginContext } from "./contexts/context";
import type { PluginManifest, PluginModule, PluginOption, PluginScope, PluginStatus, PluginType } from "./types";

export class Plugin {
	logger: Logger;

	/** 运行状态 */
	status: PluginStatus = "registered";

	/** 来源: 全局目录 or Bot私有目录 */
	scope: PluginScope;

	type: PluginType = "normal";

	/** 同清单id */
	id: string;
	manifest: PluginManifest;
	bot: Bot;

	/** 插件配置schema (定义文件里的控件定义), 未声明 manifest.config 时为 null */
	configSchema?: null | ConfigRoot = null;

	/** 插件配置(值)管理器; 未声明 manifest.config 或装配失败时为 null */
	config: ConfigManager | null = null;

	module: PluginModule | null = null;
	context: PluginContext | null = null;

	constructor(option: PluginOption) {
		this.manifest = option.manifest;
		this.id = option.manifest.id;
		this.bot = option.bot;
		this.logger = new Logger(`Plugin ${this.id}`);
		this.type = option.manifest.type || "normal";
		this.scope = option.scope;
		option.context && (this.context = option.context);
		option.module && (this.module = option.module);
	}

	/**
	 * 启动插件, 执行module.init方法
	 *
	 * 成功进入 enabled; 失败时只做资源清理(调用 error 钩子并释放上下文),
	 * 终态留给调用方 —— PluginManager.load 会把插件恢复到加载前的关态,
	 * 失败原因靠抛出的异常上报, 不占用独立状态。
	 * @param ctx 运行上下文, 由 PluginManager 创建
	 */
	async enable(ctx?: PluginContext) {
		if (this.status === "enabled") return; // 幂等
		// loading 是合法入态: PluginManager.load 已前置, 直接进入
		if (this.status === "unloading") throw new StateError(`插件 ${this.id} 正在切换状态, 请稍后再试`)
		if (!this.module) throw new Error(`插件 ${this.id} 模块未加载`);
		if (ctx === undefined && this.context === null) {
			throw new Error(`插件 ${this.id} 无运行上下文`)
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
			} catch { 
				this.logger.error(`插件载入时错误清理失败`, e)
			 }
			this.context?.dispose?.();
			this.context = null; // 上下文已释放, 断开引用避免后续误用
			throw e; // 终态由调用方恢复: 加载失败对外就是"没开起来", 不留第三种状态
		}
	}

	/**
	 * 卸载插件: 释放模块与上下文, 保留注册表条目
	 * @param [destroy=false] 销毁插件模块, 使manager.load触发再次加载, 默认不销毁
	 */
	async disable(destroy: boolean = false) {
		if (this.status === "disabled" || this.status === "registered") return; // 幂等
		if (this.status === "loading" || this.status === "unloading") throw new StateError(`插件 ${this.id} 正在切换状态, 请稍后再试`)

		this.status = "unloading";
		try {
			// context 缺失说明插件从未成功启用(init 失败时已由 error 钩子清理过), 跳过 unload
			const ctx = this.context;
			if (this.module?.unload && ctx) await this.module.unload(ctx);
		} catch (e) {
			// unload 失败也让插件尝试清理
			try {
				await this.module?.error?.(e);
			} catch(e) { 
				this.logger.error(`插件卸载时错误清理失败`, e)
			 }
		}
		this.context?.dispose();
		this.context = null; // 上下文已释放, 断开引用避免后续误用
		destroy && (this.module = null);
		this.status = "disabled";
	}
}
