import type { Message } from "../entity/message";
import type { MessageBlock } from "../protocols/message-block";
import type { Bot } from "./bot";

/**
 * 消息处理链
 *
 * 名单判定(黑白名单)**不在**这里: 它属于服务插件 `services/filter`, 在事件传播
 * 阶段就把被拦的消息挡在 Bot 的处理链之外(见 `Bot.dispatch` /
 * `ServiceHost.filterEvent`)。因此处理器拿到的消息都是放行过的。
 */
export class MessageHandler {

	constructor(private bot: Bot) {
		
	}

	handle(msg: Message) {
		this._logMessage(msg);

		// 采集昵称供 WebUI 展示; 值变化才落盘, 与统计模块无关 (统计可关闭)
		this.bot.core.profile?.touch(msg.sender.id, msg.sender.name);

		// 指令匹配: Bot 自己的指令优先, 未命中再交给全局服务指令
		const command = this.bot.command.exec(msg) || this.bot.core.services.execCommand(msg);
		if (!command) {
			// 没有匹配指令的消息, 进入消息回调(Bot 插件在前, 全局服务插件在后)
			this.bot.plugin.handleMessage(msg);
			this.bot.core.services.handleMessage(msg);
		}

		// 统计埋点; 命中指令时一并记录指令名
		this.bot.core.statistics?.record(msg, this.bot.id, { command: command || "" });
	}

	private _logMessage(message: Message) {
		const user = message.sender;
		const platform = message.platform;
		const session = message.session;

		const uinfo = this.bot.core.user!.query(user.id);
		const sinfo = this.bot.core.session!.query(session.id);

		// 优先把消息块拼接成一段文本, 再随整条日志一次性打印
		const content = this._concatBlocks(message.blocks) || message.text;

		let str = "";
		str += "[收]"
		str += `[${platform} ${session.type}:${sinfo?.id || "unknown"}]\n`
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
