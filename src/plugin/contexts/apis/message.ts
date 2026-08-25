import type { Message } from "../../../entity/message";
import type { MessageCallbackEntry, PluginMessageAPI, PluginMessageCallback } from "../types";

/**
 * 消息匹配 API 实现: 将 (匹配器, 处理器) 注册进 PluginContext 的回调表
 */
export class MessageAPI implements PluginMessageAPI {
	constructor(private register: (entry: MessageCallbackEntry) => void) { }

	all(handler: PluginMessageCallback): void {
		this.register({ matcher: () => true, handler });
	}
	full(text: string, handler: PluginMessageCallback): void {
		this.register({ matcher: (msg) => msg.text === text, handler });
	}
	start(prefix: string, handler: PluginMessageCallback): void {
		this.register({ matcher: (msg) => msg.text.startsWith(prefix), handler });
	}
	end(postfix: string, handler: PluginMessageCallback): void {
		this.register({ matcher: (msg) => msg.text.endsWith(postfix), handler });
	}
	includes(text: string, handler: PluginMessageCallback): void {
		this.register({ matcher: (msg) => msg.text.includes(text), handler });
	}
	regex(regexp: RegExp, handler: PluginMessageCallback): void {
		this.register({ matcher: (msg) => regexp.test(msg.text), handler });
	}
	match(predicate: (msg: Message) => boolean, handler: PluginMessageCallback): void {
		this.register({ matcher: predicate, handler });
	}
}
