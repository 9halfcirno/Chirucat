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
import type Logger from "../utils/logger";

/**
 * Bot 的插件宿主
 *
 * 发现 / 依赖图 / 启停 / 收敛 / 配置装配由 `ManagedHostBase` 承担, 这里只给出
 * Bot 侧的差异策略(双注册表、私有优先、上下文工厂、服务依赖豁免、适配器逃生舱)
 * 与本宿主独有的动作派发和双目录扫描。
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
