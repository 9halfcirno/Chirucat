import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import { root } from "../utils/root";
import type { BotConfig } from "./types";
import { ValidationError } from "../errors/validation-error";
import { Bot } from "./bot";
import type { Core } from "../core";

export class BotManager {
	bots = new Map<string, Bot>()

	constructor(readonly core: Core) {}

	async scan(botDir: string) {
		// 将dir解析为绝对路径
		path.isAbsolute(botDir) ? (botDir) : (botDir = path.join(root, botDir));

		
		const dirs = await fs.readdir(botDir);
		for (let dir of dirs) {
			try {
				dir = path.join(botDir, dir);
				const config = json5.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as BotConfig;

				// 验证必须字段
				if (!config.id) throw new ValidationError("读取Bot配置出错", "id", dir);
				config.path = dir;

				const bot = new Bot(config, this.core);

				this.bots.set(bot.id, bot);

			} catch (e) {
				
			}
		}
	}

	async start(id: string) {
		if (!this.bots.has(id)) throw new Error(`Bot ${id} 不存在`)
		
		const bot = this.bots.get(id)!;

		await bot.start();
	}
}