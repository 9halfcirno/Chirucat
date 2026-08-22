import type { PluginContext } from "./context";
import type { PluginManifest, PluginModule } from "./types";

export class Plugin {
	dir: string;

	/** 同清单id */
	id: string;
	manifest: PluginManifest;

	module: PluginModule | null = null;

	constructor(dir: string, manifest: PluginManifest, module: PluginModule | null = null) {
		this.dir = dir;
		this.manifest = manifest;
		this.id = manifest.id;
		this.module = module;
	}

	async init(ctx: PluginContext) {
		if (!this.module) throw new Error(`插件 ${this.id} 模块未加载`);
		await this.module.init(ctx);
	}

	async unload() {
		if (!this.module) return;
		if (this.module.unload) await this.module.unload();
		this.module = null;
	}
}
