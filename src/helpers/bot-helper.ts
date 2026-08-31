import fs from "fs/promises";
import path from "path";
import type { Core } from "../core";
import type { BotConfig } from "../bot/types";
import { root } from "../utils/root";
import { dirCheck } from "../utils/dir-check";

// 创建/删除Bot的文件夹, 并同步BotManager
export class BotHelper {
	constructor(readonly core: Core) { }

	// 在bots文件夹中创建新Bot并刷新BotManager, 自动避开重名文件夹
	async add(config: BotConfig) {
		if (!config.id) throw new Error("创建Bot失败: id不能为空");
		if (this.core.bot.bots.has(config.id)) throw new Error(`Bot ${config.id} 已存在`);

		const botsDir = path.join(root, "bots");
		await dirCheck(botsDir);

		// 避开已存在的文件夹: <id>, <id>-1, <id>-2 ...
		let dir = path.join(botsDir, config.id);
		for (let i = 1; await exists(dir); i++) {
			dir = path.join(botsDir, `${config.id}-${i}`);
		}
		config.path = dir;

		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "config.json"),
			JSON.stringify({ id: config.id, name: config.name }, null, "\t")
		);
		await fs.writeFile(
			path.join(dir, "state.json"),
			JSON.stringify({ enable: false, plugins: {} }, null, "\t")
		);

		await this.core.bot.scan(botsDir);
		return config.path;
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
