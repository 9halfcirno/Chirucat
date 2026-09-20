export type Control = InputControl | TextareaControl | SwitchControl | SelectControl | CheckboxControl | SliderControl | GroupControl | TextControl | TableControl;

export interface InputControl {
	type: "input";
	id: string;
	label: string;
	default?: string;
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

export interface TextareaControl {
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

export interface SwitchControl {
	type: "switch";
	id: string;
	label: string;
	default?: boolean;
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface SelectControl {
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

export interface CheckboxControl {
	type: "checkbox";
	id: string;
	label: string;
	items: OptionItems;
	default?: string[];
	visible?: Visible;
	required?: boolean;
	desc?: string;
}

export interface SliderControl {
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
