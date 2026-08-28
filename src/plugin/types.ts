import type { PluginContext } from "./contexts/context";

/** 依赖: 插件id -> 版本约束, 如 { "des": "=0.0.0" } */
export type PluginDependencies = Record<string, string>;

export type PluginType = "adapter" | "normal";

/** 插件来源目录 */
export type PluginScope = "global" | "bot";

export type PluginManifest = {
	id: string;
	version: string;
	author?: string;
	name?: string;
	type?: PluginType;
	description?: string;

	path: string;

	main: string;

	/**
	 * 插件依赖
	 * TODO
	 */
	dependencies?: PluginDependencies;
}

export type PluginOption = {
	manifest: PluginManifest,
	/** 插件模块, 由 PluginManager.load 加载后填充 */
	module?: PluginModule,
	/** 插件来源目录 */
	scope: PluginScope,
	/** 插件运行上下文 */
	context?: PluginContext;
}

export type PluginModule = {
	init(ctx: PluginContext): void | Promise<void>;

	unload?(): void | Promise<void>;

	/**
	 * 生命周期异常钩子: enable/disable 流程抛错时调用, 让插件尝试清理自身资源
	 */
	error?(err: unknown): void | Promise<void>;
}

/** 插件运行状态 */
export type PluginStatus =
	| "registered"   // 已注册清单, 未加载
	| "loading"      // 加载中
	| "enabled"      // 已启用
	| "unloading"    // 卸载中
	| "disabled"     // 已禁用
	| "error";       // 最近一次启停失败


export type NPMPackages = {
	dependencies: Record<string, string>
}
