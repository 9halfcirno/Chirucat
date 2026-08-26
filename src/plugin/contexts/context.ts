import type { Bot } from "../../bot/bot";
import type { Command } from "../../command/types";
import type { Entity } from "../../entity/entity";
import type { Message } from "../../entity/message";
import type { BotActions } from "../../protocols/actions";
import type { PluginManifest } from "../types";
import { MessageAPI } from "./apis/message";
import Logger from "../../utils/logger";

const logger = new Logger("PluginContext");
import type { MessageCallbackEntry, PluginCommandAPI, PluginMessageAPI } from "./types";

export class PluginContext {
	protected _bot: Bot;

	message: PluginMessageAPI;

	private _onMessageCallback: MessageCallbackEntry[] = [];

	private _commands = new Set<Command>();

	constructor(bot: Bot, manifest: PluginManifest) {
		this._bot = bot;
		this.message = new MessageAPI((entry) => {
			this._onMessageCallback.push(entry);
		});
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
	destroy() {
		// 清理指令
		for (let com of this._commands.values()) {
			this._bot.command.unregister(com)
		}
	}
}
