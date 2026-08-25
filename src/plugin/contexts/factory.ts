import type { Bot } from "../../bot/bot";
import type { PluginManifest } from "../types";
import { AdapterContext } from "./adapter-context";
import { PluginContext } from "./context";

export const PluginContextFactory = {
	create(manifest: PluginManifest, bot: Bot) {
		if (manifest.type === "adapter") {
			return new AdapterContext(bot, manifest);
		} else {
			return new PluginContext(bot, manifest);
		}
	}
}