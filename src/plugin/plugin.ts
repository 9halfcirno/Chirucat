import type { PluginContext } from "./contexts/context";
import type { PluginManifest, PluginModule } from "./types";

export class Plugin {
	dir: string;

	/** 同清单id */
	id: string;
	manifest: PluginManifest;

	module: PluginModule | null = null;
	context: PluginContext;

	constructor(manifest: PluginManifest, module: PluginModule | null = null, context: PluginContext) {
		this.dir = manifest.path;
		this.manifest = manifest;
		this.id = manifest.id;
		this.module = module;
		this.context = context;
	}

	/**
	 * 启动插件, 执行module.init方法, 可指定上下文
	 * @param ctx 指定的上下文, 默认为插件自身上下文
	 */
	async init(ctx?: PluginContext) {
		if (!this.module) throw new Error(`插件 ${this.id} 模块未加载`);
		await this.module.init(ctx || this.context);
	}

	async unload() {
		if (!this.module) return;
		if (this.module.unload) await this.module.unload();
		this.module = null;
	}
}
