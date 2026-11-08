export type Control = InputControl | TextareaControl | SwitchControl | SelectControl | CheckboxControl | SliderControl | GroupControl | TextControl | TableControl;

/**
 * 值产生型控件共有的写入策略标记
 *
 * 这些标记不参与"值是否合法"的判断: 它们约束的是**写入权限与生效时机**,
 * 由配置层(patch)与宿主(热应用)消费。
 */
export interface ControlPolicy {
	/** 框架设置: 改动需重启才生效, 落盘后不计入热应用 */
	restart?: boolean;
}

/**
 * 前端能如实禁用的控件额外的写入策略
 *
 * 自绘的下拉/多选没有原生 disabled, 给它们加 immutable 只会变成"看起来能改、
 * 后端却拒绝"的假只读 —— 因此这个标记只声明在 input / textarea / switch / slider 上。
 */
export interface ReadonlyControlPolicy extends ControlPolicy {
	/** 框架设置: 写入接口拒绝把它改成别的值; 前端置灰 */
	immutable?: boolean;
}

export interface InputControl extends ReadonlyControlPolicy {
	type: "input";
	id: string;
	label: string;
	/**
	 * 值的类型, 缺省 `string`
	 *
	 * `"number"` 时后端把数字字符串规范化为数字, 校验要求可解析为数字并满足
	 * `integer` / `min` / `max`。前端仍是文本框(数字键盘提示), 不做本地数值控件。
	 */
	valueType?: "string" | "number";
	/** valueType:"number" 时必须为整数 */
	integer?: boolean;
	/** valueType:"number" 的取值范围 */
	min?: number;
	max?: number;
	/** 敏感项: 框架设置对外读取时脱敏为空串, 写入时空串表示"不修改"; 插件配置不脱敏(插件需要明文) */
	secret?: boolean;
	/** 值的默认值; valueType:"number" 时可以是数字 */
	default?: string | number;
	visible?: Visible;
	required?: boolean;
	desc?: string;
	placeholder?: string;
	attr?: Record<string, unknown>;
}

export type Visible = boolean | Expression;

export type Expression = {
	op?: "and";
	left: Visible;
	right: Visible;
} | {
	op?: "or";
	left: Visible;
	right: Visible;
} | {
	op?: "not";
	left: Visible;
} | ({
	op?: "equal" | "notEqual" | "gt" | "gte" | "lt" | "lte";
	ref: string;
	target: unknown;
}) | ({
	op?: "in" | "notIn";
	ref: string;
	target: unknown[];
});

export interface TextareaControl extends ReadonlyControlPolicy {
	type: "textarea";
	id: string;
	label: string;
	default?: string;
	visible?: Visible;
	required?: boolean;
	desc?: string;
	placeholder?: string;
	/** 初始可见行数, 未提供时用 3 */
	rows?: number;
	attr?: Record<string, unknown>;
}

export interface SwitchControl extends ReadonlyControlPolicy {
	type: "switch";
	id: string;
	label: string;
	default?: boolean;
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface SelectControl extends ControlPolicy {
	type: "select";
	id: string;
	label: string;
	items: OptionItems;
	default?: string;
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export type OptionItems = {
	label: string;
	value: string;
}[];

export interface CheckboxControl extends ControlPolicy {
	type: "checkbox";
	id: string;
	label: string;
	items: OptionItems;
	default?: string[];
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface SliderControl extends ReadonlyControlPolicy {
	type: "slider";
	id: string;
	label: string;
	min: number;
	max: number;
	step: number;
	default?: number;
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface GroupControl {
	type: "group";
	id: string;
	label?: string;
	controls: Control[];
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface TextControl {
	type: "text";
	label: string;
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface TableControl {
	type: "table";
	id: string;
	label: string;
	controls: Control[];
	/** 初始行数据: 每项是该行子控件 id 到值的映射, 缺失的键用子控件自身的 default 填充; 未提供时表格只有表头 */
	default?: Record<string, unknown>[];
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface ConfigRoot {
	version?: string;
	controls: Control[];
}
