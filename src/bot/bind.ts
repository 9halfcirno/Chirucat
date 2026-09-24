/**
 * 提供Bind指令, 使绑定两个不同账号
 * 
 * @internal 内部临时实现，未来将重构并下沉为普通插件服务
 * @todo 待重构: 日后抽离为 Service插件
 * 
 */

import type { Command } from "../command/types";
import type { Bot } from "./bot";

export class Bind {
	/** bind命令对象 */
	command: Command = {
		name: "bind",
		handler: (msg, args) => {
			if (!msg) return; // 拿不到信息, 返回

			let token = args[0] as string;
			if (!token) { // 没token
				if (msg.session.type !== "private") {
					msg.reply(`非私聊环境无法生成绑定令牌! 请尝试转移私聊`)
					return;
				}
				let aid = msg.sender.id; // 拿到account id
				let token = this.bot.core.bindManager?.new(aid);
				if (!token) {
					msg.reply(`生成绑定令牌失败!`);
					return;
				}
				msg.reply(`已生成绑定到此账号的绑定令牌! 请在 5 分钟内进行使用 "/bind [你的令牌]" 绑定!\n\n令牌: ${token}`);
			} else { // 有令牌
				let ori = msg.sender.id;
				let res = this.bot.core.bindManager?.bind(ori, token);
				if (!res) return; // 理论上core释放时不会再收到消息?
				if (!res.success) {
					msg.reply(`绑定失败!\n原因: ${res.message}`);
					return;
				}
				msg.reply(`绑定成功! 当前账号已绑定到源账号数据`)
			}
		},
	};
	constructor(private bot: Bot) {

	}

	enable() {
		this.bot.command.register(this.command)
	}

	disable() {
		this.bot.command.unregister(this.command);
	}
}