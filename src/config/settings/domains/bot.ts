import path from "node:path";
import { defineSettings } from "../define";
import type { SettingsDefinition } from "../types";

/**
 * Bot 设置值文件名
 *
 * 与 `BotManager.scan` 读取的是同一个文件 (原来就叫 config.json),
 * 这里不迁移文件名: 迁移只会平白多一次出错的机会。
 */
export const BOT_SETTINGS_FILE_NAME = "config.json";

/** Bot 设置的形状 (运行时由定义保证) */
export interface BotSettings extends Record<string, unknown> {
	id: string;
	name: string;
}

/**
 * Bot 设置定义
 *
 * 与 state.json 的边界: 这里只放**用户意图**(身份与展示), 启停期望态
 * (`enable` / `enabledPlugins`) 留在 state.json —— 配置与状态各一份文件,
 * 合并会让"收敛运行态"反过来污染用户偏好。
 *
 * `id` 标了 immutable: 它同时是目录名、`BotManager.bots` 的 Map 键与插件配置
 * 路径的基准 (`ConfigManager.fileForPlugin(bot.path, ...)`), 改它等于搬家 +
 * 改 path + 重建索引 + 迁移状态文件, 不是一次"设置保存"该做的事。
 */
export const botSettings: SettingsDefinition = defineSettings({
	version: "1.0.0",
	fields: {
		id: {
			type: "string",
			default: "",
			required: true,
			immutable: true,
			label: "Bot ID",
			desc: "Bot 的标识, 同时也是它的目录名; 创建后不可更改",
		},
		name: {
			type: "string",
			default: "",
			label: "Bot 名称",
			placeholder: "留空表示不设名称",
			desc: "仅用于展示, 与 ID 无关",
		},
	},
});

/** 某个 Bot 的值文件路径 (Bot 目录下的 config.json) */
export function botSettingsFile(botPath: string): string {
	return path.join(botPath, BOT_SETTINGS_FILE_NAME);
}
