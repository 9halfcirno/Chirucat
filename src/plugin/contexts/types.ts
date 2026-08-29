import type { Command } from "../../command/types";
import type { Message } from "../../entity/message";
import type { BotActions } from "../../protocols/actions";
import type { BotEvents } from "../../protocols/events";
import type { SessionType } from "../../protocols/session";
import type { SessionPlatformInfo } from "../../internal/session-manager";
import type { UserPlatformInfo } from "../../internal/user-manager";

export type PluginMessageCallback = (message: Message) => unknown;

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

export interface PluginCommandAPI {
	register(name: string, handler: Command["handler"]): Command;
	unregister(command: Command): void
}

export interface PluginActionAPI {

}

export type ActionHandler = (action: BotActions, extra?: Record<string, any>) => any;
export interface PluginBotAPI {
	dispatch(event: BotEvents): void;
	onAction: (handler: ActionHandler) => void;
}

export interface PluginUserAPI {
	get: (platform: string, id: string) => string;

	query(uuid: string): UserPlatformInfo | null;
}

export interface PluginSessionAPI {
	get: (platform: string, type: SessionType, id: string) => string;
	query: (uuid: string) => SessionPlatformInfo | null
}

