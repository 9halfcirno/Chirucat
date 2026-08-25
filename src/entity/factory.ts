import type { BotEventMeta, BotEvents } from "../protocols/events";
import type { SessionManager } from "../session-manager";
import type { UserManager } from "../user-manager";
import { Message } from "./message";

const EntityFactory = {
	from(event: BotEvents, meta: BotEventMeta) {
		if (event.type === "message.create") {
			return new Message(event, meta);
		}
	}
}

export { EntityFactory }