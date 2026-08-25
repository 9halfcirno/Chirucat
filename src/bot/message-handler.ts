import type { Message } from "../entity/message";
import type { Bot } from "./bot";
import { MessageFilter } from "./message-filter";

export class MessageHandler {
	filter = new MessageFilter();

	constructor(private bot: Bot) {
		
	}

	handle(msg: Message) {
		let ok = this.filter.filter(msg);

		if (!ok) return; // 被过滤就忽略

		if (!this.bot.command.exec(msg)) {
			// 没有匹配指令的消息, 进入插件消息回调
			this.bot.plugin.handleMessage(msg);
		}
	}
}