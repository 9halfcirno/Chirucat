import type { PluginContext } from "../../src/plugin/contexts/context"

export default {
	init(ctx: PluginContext) {
		ctx.message.start("ping", (msg) => {
			console.log(msg.text);
			
		})
	}
}