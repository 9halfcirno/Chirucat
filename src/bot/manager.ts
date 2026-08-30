import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import { root } from "../utils/root";
import type { BotConfig, BotState } from "./types";
import { ValidationError } from "../errors/validation-error";
import { Bot } from "./bot";
import type { Core } from "../core";
import Logger from "../utils/logger";
import { dirCheck } from "../utils/dir-check";

const logger = new Logger("BotManager");

export class BotManager {
	bots = new Map<string, Bot>()

	constructor(readonly core: Core) { }

	async scan(botDir: string) {
		// 将dir解析为绝对路径
		path.isAbsolute(botDir) ? (botDir) : (botDir = path.join(root, botDir));
		await dirCheck(botDir);


		const seen = new Set<string>();	// 本次扫描到的Bot id
		const dirs = await fs.readdir(botDir);
		for (let dir of dirs) {
			try {
				dir = path.join(botDir, dir);
				const config = json5.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as BotConfig;

				// 验证必须字段
				if (!config.id) throw new ValidationError("读取Bot配置出错", "id", dir);
				config.path = dir;

				const state = json5.parse(
					await fs.readFile(path.join(config.path, "state.json"), "utf-8").catch(e => {
						return `{
							"enable": false,
							"plugins": {}
						}`
					})
				) as BotState

				// 已存在的实例不重建: 重建会丢失 running 等运行态, 仅更新注册表对账
				if (this.bots.has(config.id)) {
					seen.add(config.id);
					continue;
				}

				const bot = new Bot(config, this.core, state);
				seen.add(bot.id);

				this.bots.set(bot.id, bot);

			} catch (e) {

			}
		}

		// 清理悬空条目: 目录中已消失且未运行的Bot(运行中的Bot可能持有异步流程引用, 不清理)
		for (const [id, bot] of [...this.bots]) {
			if (!seen.has(id) && !bot.running) {
				this.bots.delete(id);
			}
		}
	}

	async start(...ids: string[]) {
		// 未指定id时, 启动所有 enable 状态的Bot
		if (ids.length === 0) {
			ids = [...this.bots.values()]
				.filter(bot => bot.state.enable)
				.map(bot => bot.id);
		}
		for (let id of ids) {
			if (!this.bots.has(id)) throw new Error(`Bot ${id} 不存在`)

			const bot = this.bots.get(id)!;

			await bot.start();
			logger.log(`Bot: Bot ${id} 启动成功`);
			
		}
	}

	async stop(...ids: string[]) {
		if (ids.length === 0) {
			ids = [...this.bots.values()]
				.filter(bot => bot.state.enable)
				.map(bot => bot.id);
		}
		for (let id of ids) {
			if (!this.bots.has(id)) throw new Error(`Bot ${id} 不存在`)

			const bot = this.bots.get(id)!;

			await bot.stop();
			logger.log(`Bot: Bot ${id} 停止成功`);

		}
	}

	/**
	 * 同步所有Bot的启停状态: 让运行状态收敛到各Bot的state.json(enable)
	 * - 先重读各Bot的state.json
	 * - enable=true 且未运行 → 启动
	 * - enable=false 且运行中 → 停止
	 */
	async syncState() {
		for (const bot of this.bots.values()) {
			// 先重读文件, 使内存状态与 state.json 一致
			await bot.reloadState();

			if (bot.state.enable) {
				if (!bot.running) {
					await bot.start();
					logger.log(`Bot: Bot ${bot.id} 启动成功`);
				}
			} else {
				if (bot.running) {
					await bot.stop();
					logger.log(`Bot: Bot ${bot.id} 已停止`);
				}
			}
		}
	}
}