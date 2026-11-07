import type { Bot } from "../../bot/bot";
import type { Plugin } from "../../plugin/plugin";
import type { PluginManifest, PluginScope, PluginStatus } from "../../plugin/types";

/**
 * 插件运行状态在 WebUI 中的表述
 *
 * 前端只需要"开着 / 关着 / 正在切换"三种观感: registered(从未加载) 与
 * disabled(已停用) 都收敛成 disabled —— 期望态、"没加载过"这类内部概念
 * 不往前端漏, 用户看到的永远只有运行态。
 */
export type PluginViewStatus = "enabled" | "disabled" | "loading" | "unloading";

/** 把内部状态收敛成对外的运行态表述 */
export function toViewStatus(status: PluginStatus): PluginViewStatus {
	if (status === "loading" || status === "unloading") return status;
	return status === "enabled" ? "enabled" : "disabled";
}

/**
 * 插件与服务插件共通的视图字段
 *
 * 清单里的展示字段 + 运行态投影, 两类实体逐字相同;`type` / `scope` /
 * `hasConfig` 的取值口径由各自的视图补足。
 */
export type ManagedViewBase = {
	id: string;
	name: string | undefined;
	version: string;
	author: string | undefined;
	description: string | undefined;
	/** 是否给出配置入口; 插件看装配结果, 服务插件看清单声明 */
	hasConfig: boolean;
	/** 运行状态, 供前端显示徽章与开关 */
	status: PluginViewStatus;
};

/** 投影成视图所需的最小实体形状: `Plugin` 与 `Service` 都满足 */
export type ViewSource = {
	id: string;
	manifest: PluginManifest;
	status: PluginStatus;
};

/** 把清单与运行态投影成 WebUI 视图的共通部分 */
export function toManagedView(entity: ViewSource, hasConfig: boolean): ManagedViewBase {
	const manifest = entity.manifest;
	return {
		id: entity.id,
		name: manifest.name,
		version: manifest.version,
		author: manifest.author,
		description: manifest.description,
		hasConfig,
		status: toViewStatus(entity.status),
	};
}

/**
 * 插件在 WebUI 中的视图数据: 清单里的展示字段 + 运行状态
 *
 * 不直接返回 Plugin/manifest: manifest.path 是服务器本地绝对路径, 对前端无用;
 * 前端真正关心的"有没有配置""现在是启用还是停用"也不在清单里。
 */
export type PluginView = ManagedViewBase & {
	/** 插件类型: adapter 适配器 / normal 普通插件 */
	type: string;
	/** 来源: 全局目录 / Bot 私有目录 */
	scope: PluginScope;
};

/** 某个 Bot 的插件列表视图, 按来源目录分组 */
export type PluginList = {
	global: PluginView[];
	bot: PluginView[];
};

/**
 * 插件列表接口的返回体
 *
 * 只给运行态: 期望态(state.json 的 enabledPlugins)是框架内部概念, 前端拿不到,
 * 也就无从出现"文件说开着、界面说关着"这类两套状态对不上的情况。
 */
export type PluginPayload = {
	/** Bot 是否运行中: 未运行时插件无法启停, 前端据此置灰开关 */
	running: boolean;
	plugins: PluginList;
};

/** 构造插件列表接口的返回体 (只读快照, 不触发扫描) */
export function buildPluginPayload(bot: Bot): PluginPayload {
	return {
		running: bot.running,
		plugins: buildPluginViews(bot),
	};
}

/** 构造插件列表视图 (只读快照, 不触发扫描) */
export function buildPluginViews(bot: Bot): PluginList {
	return {
		global: [...bot.plugin.globalPlugins.values()].map(toPluginView),
		bot: [...bot.plugin.botPlugins.values()].map(toPluginView),
	};
}

function toPluginView(plugin: Plugin): PluginView {
	return {
		...toManagedView(plugin, plugin.config !== null),
		type: plugin.type,
		scope: plugin.scope,
	};
}
