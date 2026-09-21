import type { BotActions } from "../protocols/actions";

export type BotConfig = {
	id: string;
	/** Bot名字 */
	name?: string;
	/** Bot目录 */
	path: string;
}

export type BotActionCallback = (action: BotActions) => void

/**
 * Bot 的持久化启停状态(期望态)
 *
 * 只表达"期望变成什么样", 不记录运行态:
 * 运行态(running / 插件实际 status)由 Bot 与 PluginManager 在内存中维护,
 * 永不回写 state.json, 否则"收敛运行态"会反过来污染用户的偏好。
 */
export type BotState = {
	/** 是否期望该 Bot 运行 */
	enable: boolean;
	/** 期望启用的插件 id 列表 */
	enabledPlugins: string[];
}