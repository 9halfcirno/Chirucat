import path from "node:path";
import { root } from "../../../utils/root";
import { defineSettings } from "../define";
import type { SettingsDefinition } from "../types";

/** 日志设置域 id */
export const LOGGING_DOMAIN_ID = "logging";

/** 日志设置值文件 */
export const LOGGING_SETTINGS_FILE = path.resolve(root, "configs", "logging.json");

/** 日志设置的形状 */
export interface LoggingSettings extends Record<string, unknown> {
	level: string;
}

/**
 * 日志设置定义
 *
 * 这一项是**热生效**的: 保存后立刻改 `Logger` 的最低级别, 不需要重启。
 * 默认值与 `Logger` 的内置默认一致 (`debug` = 全量), 这样引入设置项本身
 * 不会悄悄改变既有行为 —— 只有用户显式调高才会静默下来。
 */
export const loggingSettings: SettingsDefinition = defineSettings({
	version: "1.0.0",
	fields: {
		level: {
			type: "enum",
			default: "debug",
			items: [
				{ label: "调试 (debug)", value: "debug" },
				{ label: "信息 (info)", value: "info" },
				{ label: "警告 (warn)", value: "warn" },
				{ label: "错误 (error)", value: "error" },
			],
			label: "日志级别",
			desc: "低于该级别的日志不再进入控制台与日志页; 保存后立即生效",
		},
	},
});
