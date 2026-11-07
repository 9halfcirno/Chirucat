import type { Core } from "../../core";
import { ManagedEntity } from "../managed-entity";
import type { PluginManifest, PluginModule } from "../types";
import type { ServiceContext } from "./context";

/**
 * 服务插件模块: 与 PluginModule 同构, 上下文换成 ServiceContext
 *
 * 模块契约(init / unload / error)与普通插件完全一致, 差异只在拿到什么上下文。
 */
export type ServiceModule = PluginModule<ServiceContext>;

/**
 * 服务插件实例
 *
 * 与 `Plugin` 共用 `ManagedEntity` 的状态机与生命周期: 注册 / 加载中 / 启用 /
 * 卸载中 / 禁用, 加载失败回落到加载前的关态。区别只在于宿主: `Plugin` 属于某个
 * Bot, 每个 Bot 各持一份; `Service` 属于整个框架, 由 `ServiceHost` 在 Core 上
 * 持有唯一实例。
 *
 * 正因如此它不持有 Bot —— 服务插件的作用域是全局的, 拿不到也不该拿到"某一个 Bot"。
 */
export type ServiceOption = {
	manifest: PluginManifest;
	core: Core;
	/** 插件模块, 由 ServiceHost.load 加载后填充 */
	module?: ServiceModule;
	/** 插件运行上下文 */
	context?: ServiceContext;
};

export class Service extends ManagedEntity<ServiceContext, ServiceModule> {
	core: Core;

	constructor(option: ServiceOption) {
		super({
			manifest: option.manifest,
			loggerName: "Service",
			label: "服务插件",
			module: option.module,
			context: option.context,
		});
		this.core = option.core;
	}
}
