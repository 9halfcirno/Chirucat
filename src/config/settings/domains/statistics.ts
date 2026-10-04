import path from "node:path";
import { root } from "../../../utils/root";
import { defaultsOf } from "../compile";
import { defineSettings } from "../define";
import type { SettingsDefinition } from "../types";

/** 统计设置域 id */
export const STATISTICS_DOMAIN_ID = "statistics";

/** 统计设置值文件 (与 app.ts 启动时读的是同一份) */
export const STATISTICS_SETTINGS_FILE = path.resolve(root, "configs", "statistics.json");

/** 统计设置的形状 (与 statistics/types.ts 的 StatisticsOptions 对齐) */
export interface StatisticsSettings extends Record<string, unknown> {
	flushIntervalMs: number;
	bufferSize: number;
	detailRetentionDays: number;
	hourlyRetentionDays: number;
}

/**
 * 统计设置定义
 *
 * 四项都是**热生效**的: `StatisticsManager.updateOptions` 直接改写运行参数
 * (冲刷间隔会顺手重建定时器), 不需要重启。
 */
export const statisticsSettings: SettingsDefinition = defineSettings({
	version: "1.0.0",
	fields: {
		flushIntervalMs: {
			type: "number",
			default: 5000,
			min: 250,
			max: 60000,
			step: 250,
			integer: true,
			label: "冲刷间隔 (ms)",
			desc: "缓冲区落盘的时间间隔; 保存后立即重建定时器",
		},
		bufferSize: {
			type: "number",
			default: 500,
			min: 10,
			max: 10000,
			step: 10,
			integer: true,
			label: "缓冲条数",
			desc: "缓冲区条数上限, 达到后立即落盘",
		},
		detailRetentionDays: {
			type: "number",
			default: 7,
			min: 1,
			max: 365,
			step: 1,
			integer: true,
			label: "明细保留 (天)",
			desc: "超过后聚合为小时精度",
		},
		hourlyRetentionDays: {
			type: "number",
			default: 30,
			min: 1,
			max: 3650,
			step: 1,
			integer: true,
			label: "小时聚合保留 (天)",
			desc: "超过后聚合为天精度",
		},
	},
});

/**
 * 生成统计值文件的初始内容 (文件首次创建时用)
 *
 * 字段全部取定义的默认值, 与 `app.ts` 合用同一个真相源 —— 缺省值只在定义里维护一次。
 */
export function initialStatisticsSettings(): StatisticsSettings {
	return { ...defaultsOf(statisticsSettings) } as StatisticsSettings;
}
