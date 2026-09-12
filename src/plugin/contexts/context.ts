import type { Bot } from "../../bot/bot";
import type { Command } from "../../command/types";
import type { Entity } from "../../entity/entity";
import { Message } from "../../entity/message";
import type { BotActions } from "../../protocols/actions";
import type { PluginManifest } from "../types";
import { MessageAPI } from "./apis/message";
import Logger from "../../utils/logger";

const logger = new Logger("PluginContext");
import type { MessageCallbackEntry, PluginBotAPI, PluginCommandAPI, PluginFileSystemAPI, PluginKVAPI, PluginMessageAPI } from "./types";
import { FileSystemAPI } from "./apis/fs";
import { KVStore } from "./apis/kv";
import path from "node:path";
import { root } from "../../utils/root";
import type { PluginExports } from "../exports";
import { StateError } from "../../errors/state-error";

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

	/** dispose 幂等标记: enable失败/卸载/注册表丢弃都可能重复触发释放 */
	private _disposed = false;

	constructor(bot: Bot, protected _manifest: PluginManifest, protected _pluginExports: PluginExports) {
		this._bot = bot;
		this.logger = new Logger(`Plugin ${_manifest.id}`);
		this.message = new MessageAPI((entry) => {
			this._onMessageCallback.push(entry);
		});
		// bot.path 为绝对路径, resolve 会从其重置; 若为相对路径则以 root 为基准
		this._storageRoot = path.resolve(root, bot.path, "data", "plugins", _manifest.id);
		this.fs = new FileSystemAPI(this._storageRoot);
		this._kv = new KVStore(path.join(this._storageRoot, ".kv.db"));
		this.kv = this._kv;

		this.bot = {
			id: this._bot.id,
			name: this._bot.name
		}
	}

	bot: PluginBotAPI;
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
	 * 导入依赖插件的导出
	 *
	 * 每次调用实时查询注册表, 因此不要在插件里缓存返回值 ——
	 * 目标插件卸载后其导出即被释放, 缓存下来只会拿到已失效的对象。
	 * @param pluginId 导入插件的id
	 * @throws 目标插件当前没有导出(未加载/未导出/已卸载)时抛出 StateError
	 */
	require<T = any>(pluginId: string): T {
		if (!this._pluginExports.hasExports(pluginId)) {
			const available = this._pluginExports.ids();
			throw new StateError(
				`插件 ${this._manifest.id} 导入失败: 插件 ${pluginId} 当前没有导出` +
				(available.length ? `(当前可导入: ${available.join(", ")})` : "(当前没有任何插件提供导出)")
			);
		}
		return this._pluginExports.getExports(pluginId) as T;
	}

	/** 对外暴露的导出, 供依赖本插件的插件通过 require 获取 */
	set exports(value: any) {
		this._pluginExports.setExports(this._manifest.id, value, this);
	}

	get exports(): any {
		return this._pluginExports.getExports(this._manifest.id);
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
	 * 清理插件副作用(含对外导出)
	 *
	 * 幂等: enable 失败 / 卸载 / 注册表丢弃都会调用它。
	 * 释放导出放在最前, 后续清理即便失败也不会让导出残留在注册表里。
	 */
	dispose() {
		if (this._disposed) return;
		this._disposed = true;

		// 释放本插件导出(归属校验为当前上下文, 不会误删重新加载后的新条目)
		this._pluginExports.releaseExports(this._manifest.id, this);

		this._onMessageCallback = []; // 置空;
		// 清理指令
		for (let com of this._commands.values()) {
			this._bot.command.unregister(com)
		}
		this._commands.clear();
		// 关闭 KV 连接(插件可能从未使用 KV, 未初始化时不应视为异常);
		// 清理异常不应阻断上下文释放
		try {
			this._kv.close();
		} catch (e) {
			logger.error("Plugin context dispose: 关闭 KV 失败:", e);
		}
	}
}
