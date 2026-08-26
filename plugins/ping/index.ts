import type { PluginContext } from "../../src/plugin/contexts/context"
import Logger from "../../src/utils/logger";

const logger = new Logger("ping");

export default {
	init(ctx: PluginContext) {
		ctx.command.register("ping", (msg) => {
			msg?.reply("pong")
		})
	}
}