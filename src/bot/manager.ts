import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import { root } from "../utils/root";
import type { BotConfig } from "./types";
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
				if (!(await fs.stat(dir)).isDirectory()) continue; // 跳过散落在 Bot 目录里的文件

				const config = json5.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as BotConfig;

				// 验证必须字段
				if (!config.id) throw new ValidationError("读取Bot配置出错", "id", dir);
				config.path = dir;

				// 已存在的实例不重建: 重建会丢失 running 等运行态, 仅更新注册表对账
				if (this.bots.has(config.id)) {
					seen.add(config.id);
					continue;
				}

				const bot = new Bot(config, this.core);
				// 状态文件在这里首次载入并开始监听(构造函数保持无副作用)
				await bot.initState();

				seen.add(bot.id);
				this.bots.set(bot.id, bot);

			} catch (e) {
				// 目录不是 Bot、config.json 缺失或损坏都走这里:
				// 记录后跳过, 不能让一个坏目录拖垮整次扫描, 也不该静默消失
				logger.warn(`跳过无法加载的 Bot 目录: ${dir} (${e instanceof Error ? e.message : e})`);
			}
		}

		// 清理悬空条目: 目录中已消失且未运行的Bot(运行中的Bot可能持有异步流程引用, 不清理)
		for (const [id, bot] of [...this.bots]) {
			if (!seen.has(id) && !bot.running) {
				// 目录已不存在, 顺手停掉状态文件监听, 避免残留句柄
				await bot.dispose();
				this.bots.delete(id);
			}
		}
	}

	async start(...ids: string[]) {
		// 未指定id时, 启动所有 enable 状态的Bot
		if (ids.length === 0) {
			ids = [...this.bots.values()]
				.filter(bot => bot.state.get().enable)
				.map(bot => bot.id);
		}
		for (let id of ids) {
			if (!this.bots.has(id)) throw new Error(`Bot ${id} 不存在`)

			const bot = this.bots.get(id)!;

			await bot.start();
		}
	}

	async stop(...ids: string[]) {
		if (ids.length === 0) {
			ids = [...this.bots.values()]
				.filter(bot => bot.state.get().enable)
				.map(bot => bot.id);
		}
		for (let id of ids) {
			if (!this.bots.has(id)) throw new Error(`Bot ${id} 不存在`)

			const bot = this.bots.get(id)!;

			await bot.stop();
		}
	}

	/**
	 * 同步所有Bot的启停状态: 让运行状态收敛到各Bot的state.json
	 * - 先重读各Bot的state.json
	 * - enable=true 且未运行 → 启动
	 * - enable=false 且运行中 → 停止
	 *
	 * 单个 Bot 收敛失败不阻断其余 Bot。
	 */
	async syncState() {
		for (const bot of this.bots.values()) {
			try {
				await bot.syncState();
			} catch (e) {
				logger.error(`Bot ${bot.id} 状态收敛失败: ${e instanceof Error ? e.message : e}`);
			}
		}
	}

	/**
	 * 停止所有Bot并释放状态文件监听, 幂等
	 *
	 * 供 Core.close 调用: 进程退出前必须摘掉监听,
	 * 否则退出过程中文件变化还会触发一轮启停。
	 */
	async dispose() {
		for (const bot of [...this.bots.values()]) {
			try {
				await bot.dispose();
			} catch (e) {
				logger.error(`释放 Bot ${bot.id} 失败: ${e instanceof Error ? e.message : e}`);
			}
		}
	}
}
