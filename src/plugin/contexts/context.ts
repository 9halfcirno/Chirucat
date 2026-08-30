import type { Bot } from "../../bot/bot";
import type { Command } from "../../command/types";
import type { Entity } from "../../entity/entity";
import { Message } from "../../entity/message";
import type { BotActions } from "../../protocols/actions";
import type { PluginManifest } from "../types";
import { MessageAPI } from "./apis/message";
import Logger from "../../utils/logger";

const logger = new Logger("PluginContext");
import type { MessageCallbackEntry, PluginCommandAPI, PluginFileSystemAPI, PluginKVAPI, PluginMessageAPI } from "./types";
import { FileSystemAPI } from "./apis/fs";
import { KVStore } from "./apis/kv";
import path from "node:path";
import { root } from "../../utils/root";

export class PluginContext {
	protected _bot: Bot;

	logger: Logger;
	message: PluginMessageAPI;
	fs: PluginFileSystemAPI;
	kv: PluginKVAPI;

	/** 内部持有的 KV 存储实例, 供 dispose 关闭连接 */
	private _kv: KVStore;

	/** 插件存储根目录: bot/data/plugins/<插件id> */
	private _storageRoot: string;

	private _onMessageCallback: MessageCallbackEntry[] = [];

	private _commands = new Set<Command>();

	constructor(bot: Bot, manifest: PluginManifest) {
		this._bot = bot;
		this.logger = new Logger(`Plugin ${manifest.id}`);
		this.message = new MessageAPI((entry) => {
			this._onMessageCallback.push(entry);
		});
		// bot.path 为绝对路径, resolve 会从其重置; 若为相对路径则以 root 为基准
		this._storageRoot = path.resolve(root, bot.path, "data", "plugins", manifest.id);
		this.fs = new FileSystemAPI(this._storageRoot);
		this._kv = new KVStore(path.join(this._storageRoot, ".kv.db"));
		this.kv = this._kv;
	}

	command: PluginCommandAPI = {
		register: (name, handler) => {
			const command: Command = { name, handler };

			this._commands.add(command);
			this._bot.command.register(command);
			return command;
		},
		unregister: (command) => {
			this._commands.delete(command);
			this._bot.command.unregister(command);
		},
		exec: (message: Message | string, args?: (string | number)[]) => {
			return message instanceof Message ? this._bot.command.exec(message) : this._bot.command.exec(message, args || []);
		}
	}

	/**
	 * 触发Bot动作
	 * @param entity 事件实体
	 * @param action 动作对象
	 */
	action(entity: Entity, action: BotActions) {
		return this._bot.action(action, entity.meta.adapter, entity.extra)
	}

	/**
	 * 触发本插件的消息回调: 按注册顺序依次匹配, 错误不阻断后续, 期约不等待
	 * @param msg 框架消息
	 */
	handleMessage(msg: Message) {
		for (const entry of this._onMessageCallback) {
			try {
				if (!entry.matcher(msg)) continue;
				const result = entry.handler(msg);
				if (result instanceof Promise) {
					// 期约同步抛出, 不等待; 仅吞掉 rejection 防止 unhandledRejection
					result.catch((e) => logger.error("Plugin message callback error:", e));
				}
			} catch (e) {
				logger.error("Plugin message callback error:", e);
			}
		}
	}

	/**
	 * 清理插件副作用
	 */
	dispose() {
		this._onMessageCallback = []; // 置空;
		// 清理指令
		for (let com of this._commands.values()) {
			this._bot.command.unregister(com)
		}
		// 关闭 KV 数据库连接
		this._kv.close();
	}
}
