import type { Bot } from "../bot/bot";
import type { BotEventMeta, BotEvents } from "../protocols/events";
import type { SessionManager } from "../internal/session-manager";
import type { UserManager } from "../internal/user-manager";
import { Message } from "./message";

const EntityFactory = {
	create(event: BotEvents, meta: BotEventMeta, bot: Bot) {
		if (event.type === "message.create") {
			return new Message(event, meta, bot);
		}
	}
}

export { EntityFactory }