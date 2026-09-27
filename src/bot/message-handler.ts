import type { Message } from "../entity/message";
import type { MessageBlock } from "../protocols/message-block";
import type { Bot } from "./bot";
import { FilterLayer } from "./message-filter";

export class MessageHandler {
	/**
	 * 全局名单: 所有 Bot 共用
	 *
	 * 每层都同时约束「用户」与「会话」两个对象, 且所有层都要放行才算通过,
	 * 因此 Bot 私有名单实际优先级更高 —— 全局白名单放行的人或会话, 仍可被
	 * 某个 Bot 的私有名单排除; 反之, 任一层进了黑名单都会被拦下。
	 */
	globalFilter = new FilterLayer();
	/** Bot 私有名单 */
	botFilter = new FilterLayer();

	constructor(private bot: Bot) {
		
	}

	handle(msg: Message) {
		const ok = this.globalFilter.allow(msg) && this.botFilter.allow(msg);

		this._logMessage(msg, ok);

		// 采集昵称供 WebUI 展示; 值变化才落盘, 与统计模块无关 (统计可关闭)
		this.bot.core.profile?.touch(msg.sender.id, msg.sender.name);

		// 命中时拿到指令名, 未命中为 false
		let command: string | false = false;
		if (ok) {
			command = this.bot.command.exec(msg);
			if (!command) {
				// 没有匹配指令的消息, 进入插件消息回调
				this.bot.plugin.handleMessage(msg);
			}
		}

		// 统计埋点, 覆盖被过滤的消息; 命中指令时一并记录指令名
		this.bot.core.statistics?.record(msg, this.bot.id, {
			filtered: !ok,
			command: command || "",
		});
	}

	/**
	 * 从名单库重新装载两层名单
	 *
	 * Bot 初始化时调用; WebUI 改动名单后由核心通知刷新。
	 * 名单库不可用时保持空集 (等价于全部放行), 不让过滤链路因存储问题瘫痪。
	 */
	loadFilterList(): void {
		const layers = this.bot.core.filterList?.loadFor(this.bot.id);
		if (!layers) return;

		this.globalFilter.set(layers.global);
		this.botFilter.set(layers.bot);
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