import type { Bot } from "../bot/bot";
import type { BotEventMeta, BotEvents } from "../protocols/events";
import type { Session } from "../session/session";
import { uuid } from "../utils/uuid";

export class Entity {
	uuid = uuid();
	type: BotEvents["type"];
	time: number;
	/** 该字段建议配合UserManager使用, 不应直接使用 */
	platform: string;

	/** 事件携带的额外数据 */
	extra: Record<string, any>;

	session: Session | null = null;

	constructor(event: BotEvents, readonly meta: BotEventMeta, private bot: Bot) {
		this.type = event.type;
		this.time = event.time;
		this.platform = event.platform;
		this.extra = event.extra;
	 }
}