import fs from "fs/promises";
import path from "path";
import type { Core } from "../core";
import type { BotConfig } from "../bot/types";
import { root } from "../utils/root";
import { dirCheck } from "../utils/dir-check";

/**
 * Bot id 是否合法。
 * 目录名 = Bot id, 因此按目录名规则校验:
 * - 1~64 位字符串
 * - 不含首尾空白 (空格用于区分 `a/b` 这类误输入)
 * - 不能是 "." / ".." (目录穿越)
 * - 不含控制字符与目录非法字符: < > : " / \ | ? *
 */
export function isValidBotId(id: unknown): id is string {
	if (typeof id !== "string") return false;
	if (id.length === 0 || id.length > 64) return false;
	if (id !== id.trim()) return false;
	if (id === "." || id === "..") return false;
	return !/[\u0000-\u001f<>:"\/\\|?*]/.test(id);
}

// 创建/删除Bot的文件夹, 并同步BotManager
export class BotHelper {
	constructor(readonly core: Core) { }

	// 在bots文件夹中创建新Bot并刷新BotManager, 自动避开重名文件夹
	async add(config: Omit<BotConfig, "path">) {
		const { id, name } = config;
		if (!isValidBotId(id)) {
			throw new Error("创建Bot失败: id需为1~64位字符, 且不能含空白、点目录或 < > : \" / \\ | ? * 等字符");
		}
		if (this.core.bot.bots.has(id)) throw new Error(`Bot ${id} 已存在`);

		const botsDir = path.join(root, "bots");
		await dirCheck(botsDir);

		// 避开已存在的文件夹: <id>, <id>-1, <id>-2 ...
		let dir = path.join(botsDir, id);
		for (let i = 1; await exists(dir); i++) {
			dir = path.join(botsDir, `${id}-${i}`);
		}

		await fs.mkdir(dir, { recursive: true });
		// name 为空时不写入 config.json (Bot 构造时 name 缺失按 null 处理)
		await fs.writeFile(
			path.join(dir, "config.json"),
			JSON.stringify(name ? { id, name } : { id }, null, "\t") + "\n"
		);
		await fs.writeFile(
			path.join(dir, "state.json"),
			JSON.stringify({ enable: false, plugins: {} }, null, "\t") + "\n"
		);

		await this.core.bot.scan(botsDir);
		return dir;
	}

	// 删除对应Bot的文件夹, 没有就do nothing
	async delete(id: string) {
		const bot = this.core.bot.bots.get(id);
		let dir: string | null = null;

		if (bot) {
			if (bot.running) await bot.stop();
			dir = bot.path;
		} else {
			const candidate = path.join(root, "bots", id);
			if (await exists(candidate)) dir = candidate;
		}

		if (!dir) return false;

		await fs.rm(dir, { recursive: true, force: true });
		this.core.bot.bots.delete(id);
		return true;
	}
}

async function exists(p: string) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
