import type { PluginExports } from "../exports";
import { AdapterContext } from "./adapter-context";
import { PluginContext } from "./context";
import type { Plugin } from "../plugin";

export const PluginContextFactory = {
	create(
		plugin: Plugin,
		exports: PluginExports,
	) {
		if (plugin.manifest.type === "adapter") {
			return new AdapterContext(plugin, exports);
		} else {
			return new PluginContext(plugin, exports);
		}
	}
}
