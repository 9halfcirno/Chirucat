import type { BotActions } from "../protocols/actions";

export type BotConfig = {
	id: string;
	/** Bot目录 */
	path: string;
}

export type BotActionCallback = (action: BotActions) => void