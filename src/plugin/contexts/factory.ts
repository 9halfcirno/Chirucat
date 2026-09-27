import type { PluginExports } from "../exports";
import { AdapterContext } from "./adapter-context";
import { PluginContext } from "./context";
import type { Plugin } from "../plugin";

/** 按插件类型创建运行上下文 */
export const PluginContextFactory = {
	create(plugin: Plugin, exports: PluginExports): PluginContext {
		return plugin.manifest.type === "adapter"
			? new AdapterContext(plugin, exports)
			: new PluginContext(plugin, exports);
	}
}
