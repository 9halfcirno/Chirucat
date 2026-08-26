import type { Bot } from "../../bot/bot";
import type { BotActions } from "../../protocols/actions";
import type { BotEvents } from "../../protocols/events";
import type { SessionType } from "../../protocols/session";
import type { PluginManifest } from "../types";
import { PluginContext } from "./context";
import type { ActionHandler, PluginBotAPI, PluginSessionAPI, PluginUserAPI } from "./types";

export class AdapterContext extends PluginContext {
	private actionHandlers: ActionHandler[] = [];
	constructor(bot: Bot, private manifest: PluginManifest) {
		if (manifest.type !== "adapter") throw new Error(`Plugin Context: AdapterContext仅 type: adapter 的插件可创建`)
		super(bot, manifest);
	}

	bot: PluginBotAPI = {
		/** 
		 * 为Bot触发一个BotEvent
		 * @param event Bot事件
		 */
		dispatch: (event: BotEvents) => {
			this._bot.dispatch(event, {
				adapter: this.manifest.id
			});
		},
		/**
		 * 注册处理Bot动作的方法
		 * @param handler Action处理器
		 */
		onAction: (handler) => {
			this.actionHandlers.push(handler);
		}
	}

	user: PluginUserAPI = {
		get: (platform: string, id: string) => {
			return this._bot.core.user!.get(platform, id)
		},
		query: (uuid: string) => {
			return this._bot.core.user!.query(uuid);
		}
	}

	session: PluginSessionAPI = {
		get: (platform: string, type: SessionType, id: string) => {
			return this._bot.core.session!.get(platform, type, id)
		},
		query: (uuid) => {
			return this._bot.core.session!.query(uuid);
		},
	}

	handleAction(action: BotActions, extra?: Record<string, any>) {
		for (let handler of this.actionHandlers) {
			handler(action, extra)
		}
	}
}