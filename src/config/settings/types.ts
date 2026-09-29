import type { ConfigRoot } from "../types";

/**
 * 设置项定义
 *
 * 与 `Control`(控件定义) 的分工:
 *
 * - 本文件是**数据层的真相源**: 描述值是什么类型、默认多少、怎么校验、
 *   改动是否要重启、能否对外回显。
 * - 控件树只是它的一种投影 (见 `compile.ts` 的 `toControls`), 供前端复用
 *   已有的 config-editor 渲染, 而不是被反过来当成校验与默认值的依据。
 *
 * 因此"设置"不需要为了能被存储而伪造一份表单控件, 插件侧那套 schema 驱动的
 * `ConfigManager` 也不必被撑成两种语义。
 */

/** 选项项 (与 config/types.ts 的 OptionItems 同形) */
export interface OptionItem {
	label: string;
	value: string;
}

/** 所有设置项共有的元信息 */
export interface SettingSpecBase {
	/** 展示名; 缺省用字段键 */
	label?: string;
	/** 小字说明 */
	desc?: string;
	/** 敏感项: 只允许用在 string 上; 对外读取时脱敏为空串, patch 中空串表示"不修改"、null 表示"清除" */
	secret?: boolean;
	/** 改动需重启才生效: 落盘后不计入热应用与热通知 */
	restart?: boolean;
	/**
	 * 不可修改: 设置接口(patch)不接受把它改成别的值
	 *
	 * 只约束 patch —— 手工编辑值文件仍会让新值生效(与 state.json 的处理一致),
	 * 值文件是运维的最后手段。
	 */
	immutable?: boolean;
	/** 是否必填 (字符串/列表不得为空) */
	required?: boolean;
}

export interface StringSpec extends SettingSpecBase {
	type: "string";
	default?: string;
	placeholder?: string;
	/** 多行文本, 投影成 textarea */
	multiline?: boolean;
}

export interface NumberSpec extends SettingSpecBase {
	type: "number";
	default?: number;
	min?: number;
	max?: number;
	step?: number;
	/** 必须为整数 */
	integer?: boolean;
	/** 无 min/max (退化投影成输入框) 时的占位提示 */
	placeholder?: string;
	/**
	 * 投影成哪种控件
	 *
	 * 缺省规则是"给了 min & max 就用滑块"。对端口这种跨度上万、又需要精确输入的值
	 * 那条规则并不合适 —— 那种情况显式写 `widget: "input"`。
	 */
	widget?: "input" | "slider";
}

export interface BooleanSpec extends SettingSpecBase {
	type: "boolean";
	default?: boolean;
}

export interface EnumSpec extends SettingSpecBase {
	type: "enum";
	default?: string;
	items: readonly OptionItem[];
}

export interface StringListSpec extends SettingSpecBase {
	type: "stringList";
	default?: readonly string[];
	/**
	 * 候选集
	 *
	 * 提供时投影成复选框并校验取值(拒绝未知项); 缺省投影成多行文本,
	 * 前端按行拆分、后端接受数组或换行分隔的字符串。
	 */
	items?: readonly OptionItem[];
	/** 无候选集 (投影成多行文本) 时的占位提示 */
	placeholder?: string;
}

export type SettingSpec =
	| StringSpec
	| NumberSpec
	| BooleanSpec
	| EnumSpec
	| StringListSpec;

/** 分组元信息 (点号路径前缀的展示信息) */
export interface GroupMeta {
	label?: string;
	desc?: string;
}

/** 一份设置定义 */
export interface SettingsDefinition {
	version?: string;
	/** 分组元信息: 键为点号路径前缀, 如 "frontConfig" */
	groups?: Record<string, GroupMeta>;
	/** 设置项: 键支持点号路径, 如 "frontConfig.enableTestLab" */
	fields: Record<string, SettingSpec>;
}

/* ---------- 错误 ---------- */

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

/** 一份设置的对外快照: 控件投影 + 脱敏后的值 + 语义标记 */
export interface SettingsSnapshot {
	/**
	 * 控件定义投影, 供前端 config-editor 渲染
	 *
	 * 形状是 `ConfigRoot` (`{ controls: [...] }`) 而不是裸数组 —— 与
	 * `get_plugin_config` 返回的 define 保持一致: 前端 `createConfigList` 读的
	 * 就是 `define.controls`。裸数组会被当成"缺少 controls", 渲染出空表单。
	 */
	define: ConfigRoot;
	/** 当前值 (secret 字段已脱敏为空串) */
	values: Record<string, unknown>;
	/** 已设置(非空)的敏感字段路径 */
	setSecrets: string[];
	/** 改动后需重启才生效的字段路径 */
	restartFields: string[];
	/** 不可修改的字段路径 (前端应只读展示) */
	immutableFields: string[];
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
