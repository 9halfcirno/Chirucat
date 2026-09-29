import type { Command } from "../../src/command/types";
import type { ServiceModule } from "../../src/plugin/services/service";
import { BindManager } from "./bind-manager";

let command: Command;

export default {
	init(ctx) {
		const bm = new BindManager(ctx.core.user!); // !断言, 因为此时core一定处于开启

		const handler: Command["handler"] = (msg, args) => {
			if (!msg) return; // 拿不到信息, 返回

			let token = args[0] as string;
			if (!token) { // 没token
				if (msg.session.type !== "private" || ctx.config.get("danger.allowGroup") as boolean) {
					msg.reply(`非私聊环境无法生成绑定令牌! 请尝试转移私聊`)
					return;
				}
				let aid = msg.sender.id; // 拿到account id
				let time = (ctx.config.get("duration") as number || 5 * 60) * 1000 || 300000; // 获取时长, 默认5min
				let token = bm.new(aid, time);
				if (!token) {
					msg.reply(`生成绑定令牌失败!`);
					return;
				}
				msg.reply(`已生成绑定到此账号的绑定令牌! 请在 ${formatTime(time / 1000)} 内进行使用 "/bind [你的令牌]" 绑定!\n\n令牌: ${token}`);
			} else { // 有令牌
				let ori = msg.sender.id;
				let res = bm.bind(ori, token);
				if (!res) return; // 理论上core释放时不会再收到消息?
				if (!res.success) {
					msg.reply(`绑定失败!\n原因: ${res.message}`);
					return;
				}
				msg.reply(`绑定成功! 当前账号已绑定到源账号数据`)
			}
		}

		let com = ctx.config.get("command") as string || "bind";
		command = ctx.command.register(com, handler);

		ctx.config.watch((key, v) => {
			if (key === "command") {
				if (!command) return;
				ctx.command.unregister(command);
				let com = ctx.config.get("command") as string || "bind";
				command = ctx.command.register(com, handler); // 重置指令
			}
		})
	}
} as ServiceModule


function formatTime(sec: number) {
	const h = Math.floor(sec / 3600);
	const min = Math.floor((sec % 3600) / 60);
	const s = sec % 60;

	const parts: string[] = [];
	if (h > 0) parts.push(`${h}小时`);
	if (min > 0) parts.push(`${min}分钟`);
	if (s > 0 || parts.length === 0) parts.push(`${s}秒`);

	return parts.join("");
}