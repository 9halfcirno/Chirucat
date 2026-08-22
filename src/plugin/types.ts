import type { PluginContext } from "./context";

/** 依赖: 插件id -> 版本约束, 如 { "des": "=0.0.0" } */
export type PluginDependencies = Record<string, string>;

export type PluginType = "adapter";

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

export type PluginModule = {
	init(ctx: PluginContext): void | Promise<void>;

	unload?(): void | Promise<void>;
}

export type PluginState =
	| "registered"   // 已注册清单, 未加载
	| "loading"
	| "loaded"
	| "unloading"
	| "unloaded"
	| "error";
