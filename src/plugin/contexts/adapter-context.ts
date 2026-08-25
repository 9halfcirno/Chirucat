import type { Bot } from "../../bot/bot";
import type { BotEvents } from "../../protocols/events";
import type { SessionType } from "../../protocols/session";
import type { PluginManifest } from "../types";
import { PluginContext } from "./context";
import type { ActionHandler, PluginBotAPI, PluginSessionAPI, PluginUserAPI } from "./types";

export class AdapterContext extends PluginContext {
	private actionHandlers: ActionHandler[] = [];
	constructor(bot: Bot, private manifest: PluginManifest) {
		super(bot, manifest);
	}

	bot: PluginBotAPI = {
		dispatch: (event: BotEvents) => {
			this._bot.dispatch(event, {
				adapter: this.manifest.id
			});
		},
		onAction: (handler) => {

		}
	}

	user: PluginUserAPI = {
		get: (platform: string, id: string) => {
			return this._bot.core.user.get(platform, id)
		}
	}

	session: PluginSessionAPI = {
		get: (platform: string, type: SessionType, id: string) => {
			return this._bot.core.session.get(platform, type, id)
		}
	}
}