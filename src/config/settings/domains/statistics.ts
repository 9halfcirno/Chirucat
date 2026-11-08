import path from "node:path";
import { defaultsOf } from "../../schema";
import type { ConfigRoot } from "../../types";
import { root } from "../../../utils/root";

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
 * 统计设置 schema
 *
 * 四项都是**热生效**的: `StatisticsManager.updateOptions` 直接改写运行参数
 * (冲刷间隔会顺手重建定时器), 不需要重启。
 */
export const statisticsSettings: ConfigRoot = {
	version: "1.0.0",
	controls: [
		{
			type: "slider",
			id: "flushIntervalMs",
			label: "冲刷间隔 (ms)",
			default: 5000,
			min: 250,
			max: 60000,
			step: 250,
			integer: true,
			desc: "缓冲区落盘的时间间隔; 保存后立即重建定时器",
		},
		{
			type: "slider",
			id: "bufferSize",
			label: "缓冲条数",
			default: 500,
			min: 10,
			max: 10000,
			step: 10,
			integer: true,
			desc: "缓冲区条数上限, 达到后立即落盘",
		},
		{
			type: "slider",
			id: "detailRetentionDays",
			label: "明细保留 (天)",
			default: 7,
			min: 1,
			max: 365,
			step: 1,
			integer: true,
			desc: "超过后聚合为小时精度",
		},
		{
			type: "slider",
			id: "hourlyRetentionDays",
			label: "小时聚合保留 (天)",
			default: 30,
			min: 1,
			max: 3650,
			step: 1,
			integer: true,
			desc: "超过后聚合为天精度",
		},
	],
};

/**
 * 生成统计值文件的初始内容 (文件首次创建时用)
 *
 * 字段全部取 schema 的默认值 —— 缺省值只在 schema 里维护一次。
 */
export function initialStatisticsSettings(): StatisticsSettings {
	return { ...defaultsOf(statisticsSettings) } as StatisticsSettings;
}
