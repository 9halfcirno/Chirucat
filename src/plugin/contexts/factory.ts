import { PluginExports } from "../exports";
import { AdapterContext } from "./adapter-context";
import { PluginContext } from "./context";
import type { Plugin } from "../plugin";

/** 按插件类型创建运行上下文 */
export const PluginContextFactory = {
	create(
		plugin: Plugin,
		exports: PluginExports,
		memory: Map<string, unknown>,
		serviceExports: PluginExports | null = null,
		adapterExports: PluginExports = new PluginExports(),
	): PluginContext {
		return plugin.manifest.type === "adapter"
			? new AdapterContext(plugin, exports, serviceExports, adapterExports, memory)
			: new PluginContext(plugin, exports, serviceExports, adapterExports, memory);
	}
}
