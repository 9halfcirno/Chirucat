import type { Message } from "../entity/message";
import type { MessageBlock } from "../protocols/message-block";
import type { Bot } from "./bot";
import { MessageFilter } from "./message-filter";

export class MessageHandler {
	filter = new MessageFilter();

	constructor(private bot: Bot) {
		
	}

	handle(msg: Message) {
		let ok = this.filter.filter(msg);

		this._logMessage(msg, ok);
		if (!ok) return; // 被过滤就忽略

		if (!this.bot.command.exec(msg)) {
			// 没有匹配指令的消息, 进入插件消息回调
			this.bot.plugin.handleMessage(msg);
		}
	}

	private _logMessage(message: Message, ok: boolean = true) {
		const user = message.sender;
		const platform = message.platform;
		const session = message.session;

		const uinfo = this.bot.core.user!.query(user.id);
		const sinfo = this.bot.core.session!.query(session.id);

		// 优先把消息块拼接成一段文本, 再随整条日志一次性打印
		const content = this._concatBlocks(message.blocks) || message.text;

		let str = "";
		str += "[收]"
		str += `[${platform} ${session.type}:${sinfo?.id || "unknown"}]${ok === false ? " 已过滤" : ""}\n`
		str += `<${user.name}(${uinfo!.id})> ${content}`;

		this.bot.logger.log(str);
		
	}

	/** 按顺序把消息块拼接为可读文本 */
	private _concatBlocks(blocks: MessageBlock[]): string {
		let text = "";
		for (const block of blocks) {
			switch (block.type) {
				case "text":
					text += block.text;
					break;
				case "mention":
					text += `@${block.name || block.id}`;
					break;
				case "image":
					text += `[图片: ${block.file || block.url}]`;
					break;
			}
		}
		return text;
	}
}