import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import type { PluginManifest } from "./types";
import { ValidationError } from "../errors/validation-error";
import { dirCheck } from "../utils/dir-check";
import { root } from "../utils/root";

/**
 * 清单读取: 扫描一个插件目录, 读出其中全部插件的 manifest
 *
 * Bot 插件目录(plugins/, <Bot目录>/plugins)与框架服务目录(services/)共用同一套
 * 清单约定, 差别只在后续如何处理, 因此读取与校验在此收口。
 */

/**
 * 扫描插件目录, 读取并校验其中每个插件的清单
 *
 * 单个插件目录读不出来(清单缺失/损坏/字段不完整/同目录重复 id)只上报给调用方,
 * 不影响其余插件 —— 一个坏目录不该拖垮整次扫描。
 *
 * @param dir 插件目录, 相对路径以项目根为基准; 目录不存在时自动创建
 * @param onError 单个插件读取失败时的回调(缺省静默跳过)
 * @returns 插件 id -> 清单(已写入绝对路径 path 字段)
 */
export async function readManifests(
	dir: string,
	onError?: (error: unknown, pluginDir: string) => void,
): Promise<Map<string, PluginManifest>> {
	if (!path.isAbsolute(dir)) dir = path.join(root, dir);
	await dirCheck(dir);

	const collected = new Map<string, PluginManifest>();
	const seen = new Set<string>(); // 防止同目录出现重复插件

	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		// 跳过隐藏目录(.git / .vscode 等)与散落在目录里的文件;
		// 插件存放在一个先以点开头命名的目录里不是一种用法, 而是噪音
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

		const pluginDir = path.join(dir, entry.name);
		const manPath = path.join(pluginDir, "manifest.json");
		try {
			const file = await fs.readFile(manPath, "utf-8");
			const manifest = json5.parse(file) as PluginManifest;

			if (!manifest.id) throw new ValidationError("插件清单字段不完整", "id", manPath);
			if (!manifest.version) throw new ValidationError("插件清单字段不完整", "version", manPath);
			if (!manifest.main) throw new ValidationError("插件清单字段不完整", "main", manPath);

			if (seen.has(manifest.id)) throw new Error(`${dir} 中存在重复 id 插件: ${manifest.id}`);
			seen.add(manifest.id);

			manifest.path = pluginDir;
			collected.set(manifest.id, manifest);
		} catch (e) {
			onError?.(e, pluginDir);
		}
	}

	return collected;
}
