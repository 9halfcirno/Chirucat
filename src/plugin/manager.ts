import fs from "fs/promises";
import path from "path";
import type { PluginContext, PluginManifest, PluginModule, PluginNode } from "./types";
import { Plugin } from "./plugin";
import { PluginLoader } from "./loader";

export class PluginManager {
	loader = new PluginLoader();

	/** 已加载的插件实例: id -> Plugin */
	plugins = new Map<string, Plugin>();

	/**
	 * @param dirs 插件目录
	 */
	async scan(...dirs: string[]) {
		for (let dir of dirs) {
			// 先扫描一遍清单
			
		}
	}

	async load(ids?: string | string[]) {
	}
}
