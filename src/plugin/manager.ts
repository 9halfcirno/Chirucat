import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import { Plugin } from "./plugin";
import { PluginLoader } from "./loader";
import { root } from "../utils/root";
import type { PluginManifest } from "./types";
import { ValidationError } from "../errors/validation-error";
import { PluginContextFactory } from "./contexts/factory";
import type { Bot } from "../bot/bot";
import type { Message } from "../entity/message";
import type { BotActions } from "../protocols/actions";
import type { AdapterContext } from "./contexts/adapter-context";
import type { BotState } from "../bot/types";
import Logger from "../utils/logger";

const logger = new Logger("PluginManager");

export class PluginManager {
	loader = new PluginLoader();

	manifests = new Map<string, PluginManifest>()

	/** 已加载的插件实例: id -> Plugin */
	plugins = new Map<string, Plugin>();

	/** 所有插件id */
	private pluginIds = new Set<string>();

	constructor(private bot: Bot) {

	}

	/**
	 * 扫描插件目录并注册插件, 从右到左逐级覆盖
	 * @param dirs 插件目录
	 */
	async scan(...dirs: string[]) {
		// 收集到的插件
		let manifests = new Map<string, PluginManifest>()
		for (let dir of dirs) {
			path.isAbsolute(dir) ? (dir) : (dir = path.join(root, dir)); // 转为绝对路径
			// 先扫描一遍清单
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
					manifests.set(manifest.id, manifest);
				} catch (e) {
					logger.error(e);

				}
			}
		}

		this.pluginIds.clear(); // 先清空收集
		this.manifests.clear(); // 清空清单

		for (let manifest of manifests.values()) {
			this.pluginIds.add(manifest.id);
			this.manifests.set(manifest.id, manifest);
		}
	}

	async load(state: BotState["plugins"]): Promise<void>;
	async load(...ids: string[]): Promise<void>;
	async load(arg: BotState["plugins"] | string, ...rest: string[]) {
		// 参数归一化
		let ids: string[] = [];
		if (typeof arg !== "string") {
			ids = Object.entries(arg).filter(([key, state]) => state === true).map(([k, v]) => k)
		} else ids.push(arg, ...rest);
		logger.log(ids);
		
		for (let id of ids) {
			if (!this.pluginIds.has(id)) throw new Error(`插件 ${id} 未被索引`)
			// 获取清单
			const manifest = this.manifests.get(id);
			if (!manifest) throw new Error(`插件 ${id} 的清单未找到`)

			// 加载模块
			let module = (await this.loader.load(path.join(manifest.path, manifest.main))); // esbuild加载模块

			// 加载ctx
			const ctx = PluginContextFactory.create(manifest, this.bot);
			const plugin = new Plugin(manifest, module.default, ctx);

			this.plugins.set(manifest.id, plugin);

			await plugin.init();

			logger.log(`Plugin: 成功载入插件: ${manifest.name || "???"}(${manifest.id})`);

		}
	}

	/**
	 * 将消息派发给所有已加载插件的消息回调 (按插件加载顺序)
	 * @param msg 框架消息
	 */
	handleMessage(msg: Message) {
		for (const plugin of this.plugins.values()) {
			plugin.context.handleMessage(msg);
		}
	}

	handleAction(action: BotActions, adapter: string, extra?: Record<string, any>) {
		let adapterPlugin = this.plugins.get(adapter);
		if (!adapterPlugin || adapterPlugin.manifest.type !== "adapter") {
			logger.error(`Plugin: 已加载插件中找不到id为 ${adapter} 的适配器插件!`);
			return;
		}
		(adapterPlugin.context as AdapterContext).handleAction(action, extra);
	}
}
