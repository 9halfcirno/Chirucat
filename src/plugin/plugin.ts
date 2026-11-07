import type { Bot } from "../bot/bot";
import { ManagedEntity } from "./managed-entity";
import type { PluginContext } from "./contexts/context";
import type { PluginModule, PluginOption, PluginScope, PluginType } from "./types";

/**
 * 普通插件实体: 属于某个 Bot, 每个 Bot 各持一份实例
 *
 * 状态机、配置与模块生命周期由 `ManagedEntity` 承担; 本类只保留 Bot 侧独有的
 * 宿主引用与来源信息(全局目录 / Bot 私有目录、normal / adapter 类型)。
 */
export class Plugin extends ManagedEntity<PluginContext, PluginModule> {
	/** 来源: 全局目录 or Bot私有目录 */
	scope: PluginScope;

	type: PluginType = "normal";

	bot: Bot;

	constructor(option: PluginOption) {
		super({
			manifest: option.manifest,
			loggerName: "Plugin",
			label: "插件",
			tag: option.bot.id,
			module: option.module,
			context: option.context,
		});
		this.bot = option.bot;
		this.type = option.manifest.type || "normal";
		this.scope = option.scope;
	}
}
