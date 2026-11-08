import path from "node:path";
import { defaultsOf } from "../../schema";
import type { ConfigRoot } from "../../types";
import { root } from "../../../utils/root";

/** Core 设置域 id */
export const CORE_DOMAIN_ID = "core";

/**
 * Core 设置值文件
 *
 * 启动参数与运行期配置都从这里读, 是这份文件的唯一真相源。
 */
export const CORE_SETTINGS_FILE = path.resolve(root, "configs", "core.json");

/** Core 设置的形状 */
export interface CoreSettings extends Record<string, unknown> {
	webui: boolean;
	statistics: boolean;
}

/**
 * Core 设置 schema
 *
 * `webui` 标了 `immutable`: 设置页本身就跑在 WebUI 里, 给用户一个"点一下就再也
 * 进不来、只能去改文件"的开关不是功能, 是陷阱 —— 所以只读展示。真要关, 直接编辑
 * `configs/core.json`。
 */
export const coreSettings: ConfigRoot = {
	version: "1.0.0",
	controls: [
		{
			type: "switch",
			id: "webui",
			label: "启用 WebUI",
			default: true,
			immutable: true,
			desc: "关闭后 WebUI 服务不再启动, 而本页就在 WebUI 里 —— 因此这里只读; 需要关闭请直接编辑 configs/core.json",
		},
		{
			type: "switch",
			id: "statistics",
			label: "启用统计",
			default: true,
			desc: "关闭后不再收集业务数据统计, 统计页同时从活动栏移除; 已有数据保留, 重新打开即恢复",
		},
	],
};

/**
 * 生成 Core 值文件的初始内容 (文件首次创建时用)
 *
 * 字段全部取 schema 的默认值 —— 内容只有这一个真相源, 值文件缺失或损坏时
 * 由设置域调它生成, 不会出现第二份默认值。
 */
export function initialCoreSettings(): CoreSettings {
	return { ...defaultsOf(coreSettings) } as CoreSettings;
}
