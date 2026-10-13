import type { ConfigRoot, Control } from "./types";

/** 单条校验错误 */
export interface FieldError {
	/** 出错字段的路径, 例如 "pro-group.extra" 或 "group-controls[0].id" */
	path: string;
	/** 用于展示的字段名 */
	label: string;
	/** 错误说明 */
	message: string;
}

/* ---------- 空值判定 (与前端 isEmpty 保持一致) ---------- */

function isEmpty(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return true;
	if (Array.isArray(value) && value.length === 0) return true;
	return false;
}

/* ---------- visible 求值 (与 config-editor.js 的 evalVisible 对齐) ---------- */

type Registry = Map<string, unknown>;

function readRef(ref: unknown, registry: Registry): unknown {
	if (typeof ref !== "string") return undefined;
	return registry.get(ref);
}

function evalVisible(expr: unknown, registry: Registry, depth = 0): boolean {
	if (depth > 32) return true; // 防自引用
	if (expr === undefined || expr === null) return true;
	if (typeof expr === "boolean") return expr;
	if (typeof expr !== "object") return true;

	const e = expr as Record<string, unknown>;
	const ref = readRef(e.ref, registry);

	switch (e.op) {
		case "and":
			return evalVisible(e.left, registry, depth + 1) && evalVisible(e.right, registry, depth + 1);
		case "or":
			return evalVisible(e.left, registry, depth + 1) || evalVisible(e.right, registry, depth + 1);
		case "not":
			return !evalVisible(e.left, registry, depth + 1);
		case "equal": return ref === e.target;
		case "notEqual": return ref !== e.target;
		case "gt": return (ref as number) > (e.target as number);
		case "gte": return (ref as number) >= (e.target as number);
		case "lt": return (ref as number) < (e.target as number);
		case "lte": return (ref as number) <= (e.target as number);
		case "in": return Array.isArray(e.target) && e.target.includes(ref);
		case "notIn": return !(Array.isArray(e.target) && e.target.includes(ref));
		default: return true;
	}
}

/* ---------- registry 构建 ----------
 * 与前端一致: 顶层 + group 内的控件登记, table 行内控件不登记。
 * 重复 id 时后者覆盖前者 (与前端 registerNode 的 Map.set 行为一致)。
 */
function buildRegistry(
	controls: Control[] | undefined,
	holder: Record<string, unknown>,
	registry: Registry,
): void {
	if (!Array.isArray(controls)) return;
	for (const control of controls) {
		const id = (control as { id?: string }).id;
		if (id && control.type !== "text") registry.set(id, holder[id]);
		if (control.type === "group") {
			const nested = id ? holder[id] : undefined;
			if (nested && typeof nested === "object" && !Array.isArray(nested)) {
				buildRegistry(control.controls, nested as Record<string, unknown>, registry);
			}
		}
	}
}

/* ---------- 对外入口 ---------- */

/**
 * 校验一份配置值是否符合 schema.json 描述的控件定义
 *
 * @param define schema.json 反序列化后的对象
 * @param input  前端 getValues() 的输出 (或用户提交的原始 JSON)
 * @returns 错误列表, 空数组表示通过
 */
export function validateConfig(define: ConfigRoot, input: unknown): FieldError[] {
	const errors: FieldError[] = [];

	if (!input || typeof input !== "object" || Array.isArray(input)) {
		errors.push({ path: "", label: "配置", message: "配置必须是一个对象" });
		return errors;
	}

	const values = input as Record<string, unknown>;
	const registry: Registry = new Map();
	buildRegistry(define?.controls, values, registry);

	for (const control of define?.controls ?? []) {
		validateControl(control, values, "", errors, registry, /* inline */ false);
	}
	return errors;
}

/* ---------- 单控件递归校验 ---------- */

function validateControl(
	control: Control,
	holder: Record<string, unknown>,
	path: string,
	errors: FieldError[],
	registry: Registry,
	inline: boolean,
): void {
	if (!control || typeof control !== "object") return;

	// table 行内控件忽略 visible
	if (!inline && !evalVisible((control as { visible?: unknown }).visible, registry)) return;

	const id = (control as { id?: string }).id;
	const label = (control as { label?: string }).label ?? id ?? "";
	const value = id ? holder[id] : undefined;
	const childPath = id ? (path ? `${path}.${id}` : id) : path;

	switch (control.type) {
		case "text":
			return; // 不产生值

		case "input":
		case "textarea": {
			if (value === undefined) {
				if (control.required) pushRequired(errors, childPath, label);
				return;
			}
			if (typeof value !== "string") {
				pushType(errors, childPath, label, "字符串");
				return;
			}
			if (control.required && value === "") pushRequired(errors, childPath, label);
			return;
		}

		case "switch": {
			if (value === undefined) {
				if (control.required) pushRequired(errors, childPath, label);
				return;
			}
			if (typeof value !== "boolean") pushType(errors, childPath, label, "布尔值");
			return;
		}

		case "select": {
			if (value === undefined) {
				if (control.required) pushRequired(errors, childPath, label);
				return;
			}
			if (typeof value !== "string") {
				pushType(errors, childPath, label, "字符串");
				return;
			}
			if (control.required && value === "") {
				pushRequired(errors, childPath, label);
				return;
			}
			const allowed = (control.items ?? []).map((it) => String(it.value));
			if (!allowed.includes(value)) {
				errors.push({
					path: childPath,
					label,
					message: `${label} 的取值 "${value}" 不在可选列表中`,
				});
			}
			return;
		}

		case "checkbox": {
			if (value === undefined) {
				if (control.required) pushRequired(errors, childPath, label);
				return;
			}
			if (!Array.isArray(value)) {
				pushType(errors, childPath, label, "字符串数组");
				return;
			}
			if (control.required && value.length === 0) {
				pushRequired(errors, childPath, label);
				return;
			}
			const allowed = new Set((control.items ?? []).map((it) => String(it.value)));
			for (const v of value) {
				if (typeof v !== "string") {
					pushType(errors, childPath, label, "字符串数组");
					return;
				}
				if (!allowed.has(v)) {
					errors.push({
						path: childPath,
						label,
						message: `${label} 包含未知选项 "${v}"`,
					});
				}
			}
			return;
		}

		case "slider": {
			if (value === undefined) {
				if (control.required) pushRequired(errors, childPath, label);
				return;
			}
			if (typeof value !== "number" || Number.isNaN(value)) {
				pushType(errors, childPath, label, "数字");
				return;
			}
			if (typeof control.min === "number" && value < control.min) {
				errors.push({ path: childPath, label, message: `${label} 不能小于 ${control.min}` });
			}
			if (typeof control.max === "number" && value > control.max) {
				errors.push({ path: childPath, label, message: `${label} 不能大于 ${control.max}` });
			}
			return;
		}

		case "group": {
			if (value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
				pushType(errors, childPath, label, "对象");
				return;
			}
			const nested = (value ?? {}) as Record<string, unknown>;
			for (const child of control.controls ?? []) {
				validateControl(child, nested, childPath, errors, registry, false);
			}
			return;
		}

		case "table": {
			if (value === undefined) {
				if (control.required) pushRequired(errors, childPath, label);
				return;
			}
			if (!Array.isArray(value)) {
				pushType(errors, childPath, label, "数组");
				return;
			}
			value.forEach((row, index) => {
				const rowPath = `${childPath}[${index}]`;
				if (!row || typeof row !== "object" || Array.isArray(row)) {
					errors.push({ path: rowPath, label, message: `${label} 第 ${index + 1} 行必须是对象` });
					return;
				}
				const rowObj = row as Record<string, unknown>;
				for (const col of control.controls ?? []) {
					validateControl(col, rowObj, rowPath, errors, registry, /* inline */ true);
				}
			});
			return;
		}

		default:
			return;
	}
}

/* ---------- 小工具 ---------- */

function pushRequired(errors: FieldError[], path: string, label: string) {
	errors.push({ path, label, message: `${label} 不能为空` });
}
function pushType(errors: FieldError[], path: string, label: string, expected: string) {
	errors.push({ path, label, message: `${label} 必须是${expected}` });
}