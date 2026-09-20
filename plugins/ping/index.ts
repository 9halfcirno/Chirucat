import type { Message } from "../../src/entity/message";
import type { PluginContext } from "../../src/plugin/contexts/context"
import Logger from "../../src/utils/logger";

const logger = new Logger("ping");

export default {
	init(ctx: PluginContext) {
		let command = ctx.config.get("command") as string;
		ctx.logger.log(`Ping指令: ${command}`)
		let com = ctx.command.register(command, reply)

		ctx.config.watch((k, n, o) => {
			ctx.logger.log(k, n, o)
			if (k === "command") {
				if (o === n) return;
				ctx.logger.log(`Ping指令变化: ${o} -> ${n}`)
				ctx.command.unregister(com);
				com = ctx.command.register(n as string, reply)
			}

		})

		async function reply(msg: Message | null) {
			if (ctx.config.get("enable") === false) return;

			let offset = ctx.config.get<number>("offset");
			if (offset >= 10) await sleep(offset); 
			
			msg?.reply(ctx.config.get("reply", "pong!"));
		}

		ctx.logger.log(ctx.require("des"))
	}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))