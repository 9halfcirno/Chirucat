import type { Message } from "../entity/message";
import type { MessageBlockReceive } from "../protocols/message-block";
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
		// 整条链包一层: 日志/采集/统计任何一环抛错都不该让消息处理中断
		try {
			// Hook 埋点: 消息处理之前, 可被服务插件取消(取消后不匹配指令、不触发插件回调)
			if (this.bot.core.hooks.dispatch("before.message.handle", msg)) return;

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
		} catch (e) {
			this.bot.logger.error("处理消息时出错:", e);
		}
	}

	private _logMessage(message: Message) {
		const user = message.sender;
		const platform = message.platform;
		const session = message.session;

		// user / session 在 Core.init 早期就建立, 理论上不会为空; 但日志不该为它们抛错,
		// 取不到时用消息自带的字段兜底, 而不是用 ! 断言把崩溃留到运行时
		const uinfo = this.bot.core.user?.query(user.id);
		const sinfo = this.bot.core.session?.query(session.id);

		// 优先把消息块拼接成一段文本, 再随整条日志一次性打印
		const content = this._concatBlocks(message.blocks) || message.text;

		let str = "";
		str += "[收]"
		str += `[${platform} ${session.type}:${sinfo?.id || "unknown"}]\n`
		str += `<${user.name}(${uinfo?.id ?? user.id})> ${content}`;

		this.bot.logger.log(str);
		
	}

	/** 按顺序把消息块拼接为可读文本 */
	private _concatBlocks(blocks: MessageBlockReceive[]): string {
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
					text += `[图片: ${block.url}]`;
					break;
				case "video":
					text += `[视频: ${block.url}]`	
					break;
				case "audio":
					text += `[音频: ${block.url}]`
					break;
			}
		}
		return text;
	}
}
