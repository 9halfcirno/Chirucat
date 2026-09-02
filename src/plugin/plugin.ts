import { StateError } from "../errors/state-error";
import type { PluginContext } from "./contexts/context";
import type { PluginManifest, PluginModule, PluginOption, PluginScope, PluginStatus, PluginType } from "./types";

export class Plugin {
	/** 运行状态 */
	status: PluginStatus = "registered";

	/** 来源: 全局目录 or Bot私有目录 */
	scope: PluginScope;

	type: PluginType = "normal";

	/** 同清单id */
	id: string;
	manifest: PluginManifest;

	module: PluginModule | null = null;
	context: PluginContext | null = null;

	constructor(option: PluginOption) {
		this.manifest = option.manifest;
		this.id = option.manifest.id;
		this.type = option.manifest.type || "normal";
		this.scope = option.scope;
		option.context && (this.context = option.context);
		option.module && (this.module = option.module);
	}

	/**
	 * 启动插件, 执行module.init方法
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
			// 让插件尝试清理初始化到一半的资源
			try {
				await this.module.error?.(e);
			} catch { /* 忽略清理钩子的错误 */ }
			this.context?.dispose?.();
			this.status = "error";
			throw e;
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
			if (this.module?.unload) await this.module.unload(this.context!);
		} catch (e) {
			// unload 失败也让插件尝试清理
			try {
				await this.module?.error?.(e);
			} catch { /* 忽略清理钩子的错误 */ }
		}
		this.context?.dispose();
		destroy && (this.module = null);
		this.status = "disabled";
	}
}
