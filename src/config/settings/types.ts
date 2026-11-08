import type { ConfigRoot } from "../types";

/**
 * 框架设置的对外契约
 *
 * schema 与值规则见 `src/config/types.ts` / `src/config/schema.ts`:
 * 设置不再有独立的定义类型, 它就是一份普通 `ConfigRoot`。
 */

/** 单条字段级错误 */
export interface SettingFieldError {
	/** 设置项路径 (点号分隔) */
	path: string;
	/** 展示名 */
	label: string;
	message: string;
}

/** 设置项校验/写入失败; details 供前端定位到具体字段 */
export class SettingsError extends Error {
	constructor(message: string, readonly details: SettingFieldError[] = []) {
		super(message);
		this.name = "SettingsError";
	}
}

/* ---------- 对外快照 ---------- */

/** 一份设置的对外快照: 控件定义 + 脱敏后的值 */
export interface SettingsSnapshot {
	/**
	 * 控件定义, 供前端 config-editor 渲染
	 *
	 * 形状是 `ConfigRoot` (`{ controls: [...] }`) —— 与 `get_plugin_config`
	 * 返回的 define 保持一致: 前端 `createConfigList` 读的就是 `define.controls`。
	 */
	define: ConfigRoot;
	/** 当前值 (secret 字段已脱敏为空串) */
	values: Record<string, unknown>;
}

/** 一次 patch 的结果 */
export interface SettingsPatchResult {
	/** 写入后的值 (secret 字段已脱敏) */
	values: Record<string, unknown>;
	/** 本次真正发生变化的字段路径 */
	changed: string[];
	/** 本次改动中需要重启才生效的字段路径 */
	restartRequired: string[];
}

/* ---------- 载入结果 ---------- */

/**
 * 一次设置域载入的结果
 *
 * `created` / `recovered` 由启动层消费, 用来决定"要不要打印初始密码"或
 * "提示值文件被重建" —— 域定义文件里不掺日志逻辑。
 */
export interface SettingsLoadResult<T extends Record<string, unknown> = Record<string, unknown>> {
	/** 载入后的完整值(含敏感字段明文, 内部通道) */
	values: T;
	/** 值文件首次生成 */
	created: boolean;
	/** 值文件损坏, 已备份原文件并按默认值重建 */
	recovered: boolean;
	/** 损坏原文件的备份路径(仅 recovered 时有值) */
	backupFile?: string;
}

/** `SettingsManager.loadAll()` 的结果 */
export interface SettingsLoadAllResult {
	/** 成功载入的域, 按注册顺序 */
	loaded: { id: string; result: SettingsLoadResult }[];
	/** 载入失败的域(备份/重建也失败时会落到这里) */
	failures: { id: string; error: unknown }[];
}
