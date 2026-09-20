import type { Bot } from "../../bot/bot";
import type { PluginExports } from "../exports";
import type { PluginManifest } from "../types";
import type { ConfigManager } from "../../config/manager";
import { AdapterContext } from "./adapter-context";
import { PluginContext } from "./context";
import type { Plugin } from "../plugin";

export const PluginContextFactory = {
	create(
		plugin: Plugin,
		exports: PluginExports,
		config: ConfigManager | null = null,
	) {
		if (plugin.manifest.type === "adapter") {
			return new AdapterContext(plugin.bot, plugin.manifest, exports, config);
		} else {
			return new PluginContext(plugin.bot, plugin.manifest, exports, config);
		}
	}
}
