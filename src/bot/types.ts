import type { BotActions } from "../protocols/actions";

export type BotConfig = {
	id: string;
	/** Bot名字 */
	name?: string;
	/** Bot目录 */
	path: string;
}

export type BotActionCallback = (action: BotActions) => void

export type BotState = {
	/** Bot是否处于启用状态 */
	enable: boolean;
	/** 插件启用状态 */
	plugins: Record<string, boolean>;
}