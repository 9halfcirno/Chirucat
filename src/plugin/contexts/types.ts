import type { Message } from "../../entity/message";
import type { BotActions } from "../../protocols/actions";
import type { BotEvents } from "../../protocols/events";
import type { SessionType } from "../../protocols/session";

export type PluginMessageCallback = (message: Message) => void | Promise<void>;

/** 一条消息回调: 匹配器 + 处理器, 按注册顺序触发 */
export type MessageCallbackEntry = {
	matcher: (message: Message) => boolean;
	handler: PluginMessageCallback;
};

export interface PluginMessageAPI {
	/** 全量接收 */
	all(handler: PluginMessageCallback): void;
	/** 全词匹配 */
	full(text: string, handler: PluginMessageCallback): void;
	/** 前缀匹配 */
	start(prefix: string, handler: PluginMessageCallback): void;
	/** 后缀匹配 */
	end(postfix: string, handler: PluginMessageCallback): void;
	/** 包含 */
	includes(text: string, handler: PluginMessageCallback): void;
	/** 正则匹配 */
	regex(regexp: RegExp, handler: PluginMessageCallback): void;
	/** 自定义匹配 */
	match(predicate: ((msg: Message) => boolean), handler: PluginMessageCallback): void;
}

export interface PluginActionAPI {

}

export type ActionHandler = (action: BotActions) => any;
export interface PluginBotAPI {
	dispatch(event: BotEvents): void;
	onAction: (handler: ActionHandler) => void;
}

export interface PluginUserAPI {
	get: (platform: string, id: string) => string;
}

export interface PluginSessionAPI {
	get: (platform: string, type: SessionType, id: string) => string;
}

