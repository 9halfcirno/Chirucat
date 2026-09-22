import type { Bot } from "../bot/bot";
import type { PluginContext } from "./contexts/context";

/** 依赖: 插件id -> 版本约束, 如 { "des": "=0.0.0" } */
export type PluginDependencies = Record<string, string>;

export type PluginType = "adapter" | "normal" | "service";

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
	 * 配置定义文件 (相对插件目录), 如 "config.json"
	 *
	 * 该文件同时提供控件定义与默认值, 属于插件代码的一部分、只读;
	 * 配置值按 Bot 隔离存放在 <Bot目录>/configs/plugins/<插件id>.json
	 */
	config?: string;

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
	/** 插件实例所属bot */
	bot: Bot;
}

export type PluginModule = {
	init(ctx: PluginContext): void | Promise<void>;

	unload?(ctx: PluginContext): void | Promise<void>;

	/**
	 * 生命周期异常钩子: enable/disable 流程抛错时调用
	 *
	 * 相当于插件自己的 try/catch 兜底: init 抛错后框架会释放运行上下文,
	 * 插件在模块作用域里做过的副作用(定时器、连接等)应在这里清理干净,
	 * 使下次 init 能从头再来。
	 */
	error?(err: unknown): void | Promise<void>;
}

/**
 * 插件运行状态
 *
 * 只有"开 / 关 / 切换中"三种观感: 加载失败不占一个独立状态, 而是回落到加载
 * 前的关态, 失败原因走日志与调用方。WebUI 视图还会把 registered 与 disabled
 * 一并收敛成"关"(见 webui/server/plugin-view.ts), 不让期望态漏给前端。
 */
export type PluginStatus =
	| "registered"   // 已注册清单, 未加载
	| "loading"      // 加载中
	| "enabled"      // 已启用
	| "unloading"    // 卸载中
	| "disabled";    // 已禁用


export type NPMPackages = {
	dependencies: Record<string, string>
}
