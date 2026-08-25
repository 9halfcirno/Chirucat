import type { BotEvent } from "./event/event";
import type { MessageCreateEvent } from "./event/message";

/**
 * 事件的元数据, 如来源适配器等
 */
export type BotEventMeta = {
	/** 适配器插件的id */
	adapter: string;
}

export type BotEvents = 
	| MessageCreateEvent
