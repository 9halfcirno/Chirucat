import path from "path";
import { Plugin } from "./plugin";
import { ManagedHostBase } from "./managed-host";
import { PluginLoader } from "./loader";
import type { PluginScope } from "./types";
import type { PluginModule } from "./types";
import { PluginContextFactory } from "./contexts/factory";
import { ConfigManager } from "../config/manager";
import type { Bot } from "../bot/bot";
import type { PluginContext } from "./contexts/context";
import type { PluginManifest } from "./types";
import type { ActionResponses, BotActions } from "../protocols/actions";
import { AdapterContext } from "./contexts/adapter-context";
import { PluginExports } from "./exports";
import { StateError } from "../errors/state-error";
import type Logger from "../utils/logger";

/**
 * 插件启停的结果(与服务侧 `ServiceToggleResult` 同形状)
 */
export type PluginToggleResult = {
	/** 目标插件 id */
	id: string;
	/** 目标插件收敛后的运行态 */
	enabled: boolean;
	/** 被连带变更的插件 id: 停用时是随之卸载的依赖者, 启用时是随之加载的依赖 */
	affected: string[];
};

/**
 * Bot 的插件宿主
 *
 * 发现 / 依赖图 / 启停 / 收敛 / 配置装配由 `ManagedHostBase` 承担, 这里只给出
 * Bot 侧的差异策略(双注册表、私有优先、上下文工厂、服务依赖豁免、适配器逃生舱)
 * 与本宿主独有的动作派发、双目录扫描, 以及把启停连带结果写进白名单的 `setEnabled`。
 */
export class PluginManager extends ManagedHostBase<Plugin, PluginContext> {
	loader = new PluginLoader();

	/** 全局目录插件注册表: id -> Plugin */
	globalPlugins = new Map<string, Plugin>();

	/** Bot私有目录插件注册表: id -> Plugin */
	botPlugins = new Map<string, Plugin>();

	private pluginExports = new PluginExports();
	/** 适配器逃生舱注册表(本 Bot): AdapterContext.exports/escape 发布, Entity.escape 按事件来源取用 */
	#adapterExports = new PluginExports();

	constructor(private bot: Bot) {
		super("插件");
	}

	/* ---------- 差异策略 ---------- */

	protected loggerSource(): Logger { return this.bot.logger; }

	protected registries(): Map<string, Plugin>[] {
		return [this.globalPlugins, this.botPlugins];
	}

	/** 解析优先 Bot 私有, 与迭代顺序(全局在前)不同 */
	protected lookupRegistries(): Map<string, Plugin>[] {
		return [this.botPlugins, this.globalPlugins];
	}

	protected configFileFor(plugin: Plugin): string {
		return ConfigManager.fileForPlugin(this.bot.path, plugin.id);
	}

	protected createEntity(manifest: PluginManifest, index: number): Plugin {
		const scope: PluginScope = index === 0 ? "global" : "bot";
		return new Plugin({ manifest, scope, bot: this.bot });
	}

	protected createContext(plugin: Plugin): PluginContext {
		return PluginContextFactory.create(
			plugin, this.pluginExports, this.bot.core.services.exports, this.#adapterExports);
	}

	protected async loadModule(plugin: Plugin): Promise<PluginModule> {
		const loaded = await this.loader.load(path.join(plugin.manifest.path, plugin.manifest.main));
		if (!loaded?.default) throw new Error(`插件 ${plugin.id} 没有默认导出`)
		return loaded.default;
	}

	protected beforeEnable(plugin: Plugin): boolean {
		// Hook 埋点: 插件启用之前, 可被服务插件取消
		return this.bot.core.hooks.dispatch("before.plugin.enable", plugin);
	}

	protected releaseExports(plugin: Plugin): void {
		this.pluginExports.releaseExports(plugin.id);
		this.#adapterExports.releaseExports(plugin.id);
	}

	/** 服务插件由 Core 先于所有 Bot 加载, 不进 Bot 的依赖图, 也不算缺失 */
	protected isDependencyExempt(id: string): boolean {
		return this.bot.core.services.registry.has(id);
	}

	protected acceptManifest(manifest: PluginManifest, id: string): boolean {
		// service 类型归 services/ 目录(由 ServiceHost 承接全局单例);
		// 出现在 Bot 插件目录里是放错了地方 —— 按普通插件加载会每个 Bot 各起一份
		if (manifest.type !== "service") return true;
		this.bot.logger.warn(`插件 ${id} 声明为 service 类型, 应放入 services/ 目录, 已跳过`);
		return false;
	}

	protected onReadError(error: unknown): void {
		this.bot.logger.error(error);
	}

	/* ---------- 本宿主独有的入口 ---------- */

	/**
	 * 扫描插件目录, 创建 Plugin 实例(不加载模块)。
	 * 只维护注册表, 不改变运行状态: 已启用实例不被替换, 悬空条目只清理非活跃态。
	 */
	async scan(paths: { global: string, bot: string }): Promise<void> {
		await this.scanDir(paths.global, this.globalPlugins, 0);
		await this.scanDir(paths.bot, this.botPlugins, 1);
		this.checkDependencyCycles();
	}

	/** 已启用插件, 按注册顺序(全局在前, Bot私有在后) */
	get enabledPlugins(): Plugin[] {
		return this.enabledEntities();
	}

	/**
	 * 同步插件启停状态: 让运行状态收敛到期望状态
	 *
	 * 期望名单在**调用点**读取白名单( Bot.state 的 enabledPlugins ); 本宿主没有
	 * 串行队列, 也不需要"在队列内部重算"的语义(那是服务宿对黑名单的要求)。
	 */
	async syncState(desired: string[] = this.bot.state.get().enabledPlugins): Promise<string[]> {
		return this.convergeState(new Set(desired));
	}

	/**
	 * 设置插件的期望启用状态: 先把运行态收敛成功, 再把连带结果一并写进白名单
	 *
	 * 与服务宿 `ServiceHost.setEnabled` 同一口径, 差别只在期望态的形状: Bot 的
	 * 白名单是 opt-in, 所以"停用"等于从名单里移除。连带必须一起落盘 —— 只写
	 * 目标自身一个 id 时, 重启后仍在名单里的依赖者会沿 `load` 的递归把整棵
	 * 依赖树重新拉起, 用户只能从叶子往上逐个关才能关干净。
	 *
	 * 启用方向不需要落盘依赖: 依赖是被隐式拉起、不进白名单的(见
	 * docs/concepts/bot.md), 连带 id 只用于回报前端对齐卡片。
	 *
	 * 串行队列在 Bot 侧(`Bot.serialize`), 本方法假定调用方已持有该队列。
	 */
	async setEnabled(id: string, enabled: boolean): Promise<PluginToggleResult> {
		const plugin = this.resolve(id);
		if (!plugin) throw new Error(`插件 ${id} 未被索引`);
		if (plugin.status === "loading" || plugin.status === "unloading") {
			throw new StateError(`插件 ${id} 正在切换状态, 请稍后再试`);
		}

		if (enabled) {
			const deps = this.collectDependencies(id);
			const before = this.statusesOf(deps);
			await this.load(id); // 停着的依赖由 load 递归拉起
			const affected = deps.filter(dep =>
				before.get(dep) !== "enabled" && this.resolve(dep)?.status === "enabled");
			await this.bot.state.setEnabledMany([id], true);
			return { id, enabled: this.resolve(id)?.status === "enabled", affected };
		}

		const dependents = this.collectDependents(id);
		const before = this.statusesOf(dependents);
		await this.unload(id); // 依赖它的插件由 unloadTree 递归卸载
		// 连带只算"本来在跑、这次真被关掉"的依赖者: 本来就关着的不是本次的变化,
		// 把它们写进期望等于替用户做一个他没做过的决定
		const affected = dependents.filter(dep =>
			before.get(dep) === "enabled" && this.resolve(dep)?.status !== "enabled");

		await this.bot.state.setEnabledMany([id, ...affected], false);
		return { id, enabled: this.resolve(id)?.status === "enabled", affected };
	}

	/** 适配器逃生舱注册表(本 Bot): 发布端在 AdapterContext.exports/escape, 消费端是 Entity.escape / ctx.adapterEscape */
	get adapterExports(): PluginExports {
		return this.#adapterExports;
	}

	async handleAction<T extends BotActions>(action: T, adapter: string, extra?: Record<string, any>): Promise<ActionResponses[T["type"]]> {
		const adapterPlugin = this.enabledPlugins.find(p => p.id === adapter && p.manifest.type === "adapter");
		if (!adapterPlugin) {
			this.bot.logger.error(`已启用插件中找不到id为 ${adapter} 的适配器插件!`);
			return { success: false, error: "No adapter on this bot.", code: "ADAPTER_NOT_FOUND" };
		}

		const context = adapterPlugin.context;
		// 本方法的契约是"总能给出响应对象": 上下文缺失说明适配器已被卸载,
		// 这里必须显式返回失败响应, 而不是用 `?.` 让 undefined 漏给调用方
		if (!(context instanceof AdapterContext)) {
			this.bot.logger.error(`适配器插件 ${adapter} 没有可用的运行上下文, 无法处理动作 ${action.type}`);
			return {
				success: false,
				error: "Adapter context is not available.",
				code: "ADAPTER_NOT_FOUND",
			} as ActionResponses[T["type"]];
		}

		return await context.handleAction(action, extra);
	}
}
