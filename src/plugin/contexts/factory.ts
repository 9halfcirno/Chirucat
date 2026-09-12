import type { Bot } from "../../bot/bot";
import type { PluginExports } from "../exports";
import type { PluginManifest } from "../types";
import { AdapterContext } from "./adapter-context";
import { PluginContext } from "./context";

export const PluginContextFactory = {
	create(manifest: PluginManifest, bot: Bot, exports: PluginExports) {
		if (manifest.type === "adapter") {
			return new AdapterContext(bot, manifest, exports);
		} else {
			return new PluginContext(bot, manifest, exports);
		}
	}
}