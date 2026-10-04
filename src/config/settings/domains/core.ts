import path from "node:path";
import { root } from "../../../utils/root";
import { defaultsOf } from "../compile";
import { defineSettings } from "../define";
import type { SettingsDefinition } from "../types";

/** Core 设置域 id */
export const CORE_DOMAIN_ID = "core";

/**
 * Core 设置值文件
 *
 * 与 `app.ts` 启动时读的是同一份: 域负责运行期读写, 启动参数仍由 app.ts 组装。
 */
export const CORE_SETTINGS_FILE = path.resolve(root, "configs", "core.json");

/** Core 设置的形状 */
export interface CoreSettings extends Record<string, unknown> {
	webui: boolean;
	statistics: boolean;
}

/**
 * Core 设置定义
 *
 * `webui` 标了 `immutable`: 设置页本身就跑在 WebUI 里, 给用户一个"点一下就再也
 * 进不来、只能去改文件"的开关不是功能, 是陷阱 —— 所以只读展示。真要关, 直接编辑
 * `configs/core.json`。
 */
export const coreSettings: SettingsDefinition = defineSettings({
	version: "1.0.0",
	fields: {
		webui: {
			type: "boolean",
			default: true,
			immutable: true,
			label: "启用 WebUI",
			desc: "关闭后 WebUI 服务不再启动, 而本页就在 WebUI 里 —— 因此这里只读; 需要关闭请直接编辑 configs/core.json",
		},
		statistics: {
			type: "boolean",
			default: true,
			label: "启用统计",
			desc: "关闭后不再收集业务数据统计, 已有数据保留; 保存后立即生效",
		},
	},
});

/**
 * 生成 Core 值文件的初始内容 (文件首次创建时用)
 *
 * 字段全部取定义的默认值 —— 内容只有这一个真相源, `app.ts` 与设置域
 * 载入到缺失文件时都调它, 两边建出来的文件不会不一样。
 */
export function initialCoreSettings(): CoreSettings {
	return { ...defaultsOf(coreSettings) } as CoreSettings;
}
