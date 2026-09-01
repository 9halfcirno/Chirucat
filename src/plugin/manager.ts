import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import { Plugin } from "./plugin";
import { PluginLoader } from "./loader";
import { root } from "../utils/root";
import type { PluginManifest, PluginScope, PluginStatus } from "./types";
import { ValidationError } from "../errors/validation-error";
import { StateError } from "../errors/state-error";
import { PluginContextFactory } from "./contexts/factory";
import type { Bot } from "../bot/bot";
import type { Message } from "../entity/message";
import type { BotActions } from "../protocols/actions";
import type { AdapterContext } from "./contexts/adapter-context";
import type { BotState } from "../bot/types";
import Logger from "../utils/logger";
import { dirCheck } from "../utils/dir-check";
import { dfs } from "../utils/dfs";

const logger = new Logger("PluginManager");

export class PluginManager {
	loader = new PluginLoader();

	/** 全局目录插件注册表: id -> Plugin */
	globalPlugins = new Map<string, Plugin>();

	/** Bot私有目录插件注册表: id -> Plugin */
	botPlugins = new Map<string, Plugin>();

	constructor(private bot: Bot) {

	}

	/**
	 * 扫描插件目录, 创建Plugin实例(不加载模块)。
	 * 只维护注册表, 不改变任何插件的运行状态:
	 * - 已启用插件的实例不被替换, 仅更新清单(模块已在内存)
	 * - 目录中已消失的悬空插件, 仅清理不在运行中的(非enabled)
	 * @param paths 插件目录: global 全局目录, bot Bot私有目录(覆盖global同名插件)
	 */
	async scan(paths: { global: string, bot: string }) {
		await this.scanDir(paths.global, "global", this.globalPlugins);
		await this.scanDir(paths.bot, "bot", this.botPlugins);
		this.checkDependencyCycles();
	}

	/** 解析插件的依赖插件列表(已注册的); 缺失依赖直接报错并跳过 */
	private getDependencyPlugins(plugin: Plugin): Plugin[] {
		const deps: Plugin[] = [];
		for (const depId of Object.keys(plugin.manifest.dependencies ?? {})) {
			const dep = this.resolve(depId);
			if (!dep) {
				logger.error(`Plugin: 插件 ${plugin.id} 的依赖 ${depId} 未注册`);
				continue;
			}
			deps.push(dep);
		}
		return deps;
	}

	/** 全图循环检测: 以每个插件为根跑一次dfs, 发现环就warn(不阻断扫描) */
	private checkDependencyCycles() {
		// 环上节点只报告一次
		const reported = new Set<string>();
		for (const plugin of [...this.globalPlugins.values(), ...this.botPlugins.values()]) {
			if (reported.has(plugin.id)) continue;
			const cycle = dfs(plugin, p => p.id, p => this.getDependencyPlugins(p));
			if (!cycle) continue;
			cycle.forEach(p => reported.add(p.id));
			logger.warn(`Plugin: 检测到插件依赖循环: ${cycle.map(p => p.id).join(" -> ")}`);
		}
	}

	/** 扫描单个插件目录并同步到对应注册表 */
	private async scanDir(dir: string, scope: PluginScope, registry: Map<string, Plugin>) {
		path.isAbsolute(dir) ? (dir) : (dir = path.join(root, dir)); // 转为绝对路径
		await dirCheck(dir);

		// 收集本目录清单
		const collected = new Map<string, PluginManifest>();
		const seen = new Set<string>();	// 防止同目录出现重复插件
		const pluginDirs = await fs.readdir(dir);
		for (let pluginDir of pluginDirs) {

			pluginDir = path.join(dir, pluginDir);
			const manPath = path.join(pluginDir, "manifest.json");
			try {
				const file = await fs.readFile(manPath, "utf-8");
				const manifest = json5.parse(file) as PluginManifest;

				if (!manifest.id) throw new ValidationError("插件清单字段不完整", "id", manPath)
				if (!manifest.version) throw new ValidationError("插件清单字段不完整", "version", manPath)
				if (!manifest.main) throw new ValidationError("插件清单字段不完整", "main", manPath)

				if (seen.has(manifest.id)) throw new Error(`${dir} 中存在重复 id 插件: ${manifest.id}`)
				seen.add(manifest.id);

				manifest.path = pluginDir;
				collected.set(manifest.id, manifest);
			} catch (e) {
				logger.error(e);

			}
		}

		// 更新注册表
		for (const [id, manifest] of collected) {
			const existing = registry.get(id);
			if (existing?.status === "enabled") {
				// 运行中的插件不替换实例, 仅更新清单
				existing.manifest = manifest;
			} else {
				registry.set(id, new Plugin({ manifest, scope }));
			}
		}

		// 清理悬空条目: 目录中已消失且不在运行中的插件
		// 活跃态(enabled/loading/unloading)持有异步流程引用, 不清理
		const ACTIVE: PluginStatus[] = ["enabled", "loading", "unloading"];
		for (const [id, plugin] of [...registry]) {
			if (!collected.has(id) && !ACTIVE.includes(plugin.status)) {
				registry.delete(id);
			}
		}
	}

	/**
	 * 解析插件: 优先Bot私有, 回退全局
	 * @param id 插件id
	 */
	resolve(id: string): Plugin | undefined {
		return this.botPlugins.get(id) ?? this.globalPlugins.get(id);
	}

	/** 已启用插件, 按注册顺序(全局在前, Bot私有在后) */
	get enabledPlugins(): Plugin[] {
		return [...this.globalPlugins.values(), ...this.botPlugins.values()]
			.filter(p => p.status === "enabled");
	}

	/**
	 * 启动指定插件: 加载模块并创建上下文, 幂等
	 * @param id 插件id
	 */
	async load(id: string): Promise<void> {
		const plugin = this.resolve(id);
		if (!plugin) throw new Error(`插件 ${id} 未被索引`)
		if (plugin.status === "enabled") return; // 幂等
		if (plugin.status === "loading" || plugin.status === "unloading") throw new StateError(`插件 ${id} 正在切换状态, 请稍后再试`)

		// 依赖环预检: 存在循环则拒绝加载
		const cycle = dfs(plugin, p => p.id, p => this.getDependencyPlugins(p));
		if (cycle) throw new StateError(`插件依赖存在循环, 拒绝加载: ${cycle.map(p => p.id).join(" -> ")}`);

		// 先按依赖顺序递归加载依赖(缺失依赖已在 getDependencyPlugins 中报错并跳过)
		for (const dep of this.getDependencyPlugins(plugin)) {
			await this.load(dep.id);
		}

		// 前置loading: 覆盖整个加载流程(含模块构建), 防止scan清理悬空条目时误删
		plugin.status = "loading";
		try {
			// 加载模块(未加载过, 或上次卸载时已释放)
			if (!plugin.module) {
				const loaded = await this.loader.load(path.join(plugin.manifest.path, plugin.manifest.main));
				if (!loaded?.default) throw new Error(`插件 ${id} 没有默认导出`)
				plugin.module = loaded.default;
			}

			// 启用插件
			const context = PluginContextFactory.create(plugin.manifest, this.bot);
			await plugin.enable(context);

			logger.log(`Plugin: 成功载入插件: ${plugin.manifest.name || "???"}(${plugin.id})`);
		} catch (e) {
			// 构建/加载失败: 落error而非卡在loading
			if (plugin.status === "loading") plugin.status = "error";
			throw e;
		}
	}

	/**
	 * 卸载指定插件: 释放运行态, 保留注册表条目。
	 * 仅处理运行时, 不修改持久化的启停偏好(由调用方显式 saveState)。
	 * @param ids 插件id
	 */
	async unload(...ids: string[]) {
		for (let id of ids) {
			await this.unloadTree(id, []);
		}
	}

	/** 递归卸载: 先卸载依赖该插件的插件, 再卸载自身 */
	private async unloadTree(id: string, stack: string[]): Promise<void> {
		if (stack.includes(id)) return; // 依赖环防御, 防止无限递归

		for (const dependent of this.getDependents(id)) {
			await this.unloadTree(dependent.id, [...stack, id]);
		}

		const plugin = this.resolve(id);
		if (!plugin || plugin.status === "disabled" || plugin.status === "registered") return; // 幂等
		await plugin.disable(true);

		logger.log(`Plugin: 已卸载插件: ${plugin.id}`);
	}

	/** 依赖指定插件的插件列表(跨 global/bot 注册表) */
	private getDependents(id: string): Plugin[] {
		return [...this.globalPlugins.values(), ...this.botPlugins.values()]
			.filter(p => p.manifest.dependencies?.[id]);
	}

	/**
	 * 同步插件启停状态: 让运行状态收敛到期望状态
	 * 无参时从 state.json 读取期望状态(通过 bot.state.plugins)
	 * @param desired 期望状态: id -> 是否启用, 缺省读 state.json
	 */
	async syncState(desired: BotState["plugins"] = this.bot.state.plugins) {
		// 先卸载期望关闭的
		for (const plugin of [...this.enabledPlugins]) {
			if (desired[plugin.id] !== true) {
				await this.unload(plugin.id);
			}
		}

		// 再加载期望开启的
		for (const [id, on] of Object.entries(desired)) {
			if (!on) continue;
			if (!this.resolve(id)) {
				logger.warn(`Plugin: 期望启用但未注册的插件: ${id}`);
				continue;
			}
			try {
				await this.load(id);
			} catch (e) {
				// 单个插件加载失败(如依赖循环)不阻断状态收敛, 记录后继续
				logger.error(`Plugin: 插件 ${id} 加载失败: ${e instanceof Error ? e.message : e}`);
			}
		}
	}

	/**
	 * 将消息派发给所有已启用插件的消息回调 (按注册顺序)
	 * @param msg 框架消息
	 */
	handleMessage(msg: Message) {
		for (const plugin of this.enabledPlugins) {
			plugin.context?.handleMessage(msg);
		}
	}

	async handleAction(action: BotActions, adapter: string, extra?: Record<string, any>) {
		const adapterPlugin = this.enabledPlugins.find(p => p.id === adapter && p.manifest.type === "adapter");
		if (!adapterPlugin) {
			logger.error(`Plugin: 已启用插件中找不到id为 ${adapter} 的适配器插件!`);
			return;
		}
		await (adapterPlugin.context as AdapterContext).handleAction(action, extra);
	}
}
