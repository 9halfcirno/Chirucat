import type { Message } from "../../src/entity/message";
import type { PluginContext } from "../../src/plugin/contexts/context"
import Logger from "../../src/utils/logger";

const logger = new Logger("test");

export default {
	init(ctx: PluginContext) {
		let command = ctx.config.get("command") as string;
		let com = ctx.command.register(command, reply)

		ctx.config.watch((k, n, o) => {
			if (k === "command") {
				if (o === n) return;
				ctx.command.unregister(com);
				com = ctx.command.register(n as string, reply)
			}

		})

		async function reply(msg: Message | null, args: (string | number)[]) {
			if (ctx.config.get("enable") === false) return;
			if (!msg) return;

			let features = ctx.config.get("features") as string[];
			if (!args || args.length === 0) {
				msg.reply(`## 测试:

- 当前测试指令: /${ctx.config.get("command")}
- 启用的测试功能: \n  - ${features.join("\n  - ") || "无"}`)
			} else {
				if (args[0] === "reply") {
					if (!features.includes("reply")) return;

					msg.reply(`测试引用回复: \n- 消息ID: ${msg.id}\n- 引用Token: ${msg.token}`, { quote: true })
				} else if (args[0] === "delete") {
					if (!features.includes("delete")) return;

					let res = await msg.reply(`测试撤回: \n该消息将在 5s 后尝试撤回!`);
					if (!res.success) {
						msg.reply(`无法进行撤回: message.send响应失败: ${res.error}`)
						return;
					};
					let id = res.id;
					await sleep(5000);
					msg.action({
						type: "message.delete",
						session: msg.session.id,
						id
					})
				} else if (["image", "video", "audio"].includes(String(args[0]))) {
					if (!features.includes("media")) return;

					let url = ctx.config.get("mediaUrl." + args[0]) as string;
					if (!url) {
						let buffer = await ctx.plugin.read("assets/test.png") as Buffer;
						let res = await msg.reply([{ type: "image", buffer }]);
						if (res.success === false) return msg.reply(`本地图片(Buffer)发送失败: ${res.code || "NULL_CODE"}: ${res.error}`)
						return msg.reply(`图片分片发送完成!\nmsg_id: ${res.id}`);
					}
					
					let res = await msg.reply([{ type: args[0] as any, url: url }])

					if (!res.success) {
						msg.reply(`发送失败: ${res.code || "NULL_CODE"}: ${res.error}`)
					}
				}
			}
		}
	}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))