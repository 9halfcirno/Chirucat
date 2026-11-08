/**
 * schema 的值推导纯函数
 *
 * 不依赖存储、不持有状态: `ConfigBase`(插件配置与框架设置共用)与设置域的
 * 严格 patch 都从这里取值规则, 于是"默认值 / 规范化 / 合法性"只有一份实现。
 *
 * 分三类:
 * - `defaultsOf` / `defaultValueOf`: 从控件定义展开默认值
 * - `coerceValues`: 宽松规范化(补默认、丢未知键、数值字符串转数字)
 * - `checkValue` / `sanitizeLoaded`: 合法性判定; 严格写入与"读盘坏值回落默认"
 *   共用同一套规则
 */
import { cloneValue, isPlainObject } from "./store";
import type { ConfigRoot, ConfigValues, Control } from "./types";

/** 单个值的判定结果 */
export type ValueCheck =
	| { ok: true; value: unknown }
	| { ok: false; message: string };

const ok = (value: unknown): ValueCheck => ({ ok: true, value });
const fail = (message: string): ValueCheck => ({ ok: false, message });

/** 数字或数字字符串 -> number; 其余(含空串) -> NaN */
function numericValue(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim() !== "") return Number(value);
	return Number.NaN;
}

/**
 * 单个控件的默认值
 *
 * 必须与前端 config-editor.js 的 defaultValueOf 逐条保持一致,
 * 否则前端 reset 出来的值与后端补齐的值会不同。
 */
export function defaultValueOf(control: Control): unknown {
	switch (control.type) {
		case "group":
			return {};
		case "table":
			return [];
		case "checkbox":
			return Array.isArray(control.default) ? cloneValue(control.default) : [];
		case "switch":
			return control.default === true;
		case "slider":
			return typeof control.default === "number" ? control.default : control.min;
		case "input":
			// 数值输入没有默认值时不能用空串: 它会被当成"填了个非数字"
			if (control.valueType === "number") {
				const num = typeof control.default === "number" ? control.default : Number(control.default);
				return Number.isFinite(num) ? num : (control.min ?? 0);
			}
			return control.default === undefined ? "" : cloneValue(control.default);
		case "text":
			return undefined;
		default:
			return control.default === undefined ? "" : cloneValue(control.default);
	}
}

/** 用列控件的默认值补全一行 (table 用) */
export function fillRow(columns: readonly Control[], row: Record<string, any>): ConfigValues {
	const out: ConfigValues = {};

	for (const column of columns) {
		if (column.type === "text") continue;
		out[column.id] = Object.prototype.hasOwnProperty.call(row, column.id)
			? cloneValue(row[column.id])
			: defaultValueOf(column);
	}
	return out;
}

/** 按控件数组展开一份默认值 */
export function defaultsForControls(controls: readonly Control[]): ConfigValues {
	const out: ConfigValues = {};

	for (const control of controls) {
		if (control.type === "text") continue; // text 只作说明, 不产生值
		if (control.type === "group") {
			out[control.id] = defaultsForControls(control.controls ?? []);
		} else if (control.type === "table") {
			out[control.id] = (control.default ?? []).map((row) =>
				fillRow(control.controls ?? [], isPlainObject(row) ? row : {}),
			);
		} else {
			out[control.id] = defaultValueOf(control);
		}
	}
	return out;
}

/** 按一份 schema 展开默认值 */
export function defaultsOf(schema: ConfigRoot): ConfigValues {
	return defaultsForControls(schema?.controls ?? []);
}

/**
 * 宽松规范化: 只保留 schema 已知的键, 未知键丢弃
 *
 * - 键缺失时回落到 fallback 的同路径值, 再回落到控件默认值
 * - group 递归; table 整表替换, 行内用列默认值补全
 * - 数值输入把数字字符串转成数字
 */
export function coerceValues(
	controls: readonly Control[],
	source?: unknown,
	fallback?: unknown,
): ConfigValues {
	const src = isPlainObject(source) ? source : {};
	const fb = isPlainObject(fallback) ? fallback : {};
	const out: ConfigValues = {};

	for (const control of controls) {
		if (control.type === "text") continue;
		const id = control.id;
		const hasSrc = Object.prototype.hasOwnProperty.call(src, id);
		const hasFb = Object.prototype.hasOwnProperty.call(fb, id);

		if (control.type === "group") {
			out[id] = coerceValues(
				control.controls ?? [],
				hasSrc ? src[id] : undefined,
				hasFb ? fb[id] : undefined,
			);
			continue;
		}

		if (control.type === "table") {
			// 行集合以提交值为准; 提交与旧值都没有时回落到控件自身的 default
			const rows = hasSrc ? src[id] : (hasFb ? fb[id] : control.default ?? []);
			out[id] = (Array.isArray(rows) ? rows : []).map((row) =>
				fillRow(control.controls ?? [], isPlainObject(row) ? row : {}),
			);
			continue;
		}

		let value = hasSrc
			? cloneValue(src[id])
			: hasFb
				? cloneValue(fb[id])
				: defaultValueOf(control);

		// 数值输入把数字字符串规范化成数字; 无法解析时原样保留, 由校验报错
		if (control.type === "input" && control.valueType === "number"
			&& typeof value === "string" && value.trim() !== "") {
			const num = Number(value);
			if (Number.isFinite(num)) value = num;
		}
		out[id] = value;
	}
	return out;
}

/**
 * 按点号路径写入嵌套值, 中间层不存在时创建对象
 *
 * 路径之间不存在前缀冲突 (`a` 与 `a.b` 不能共存), 因此中间层一定是纯对象。
 */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.split(".");
	const last = segments.pop()!;

	let node = target;
	for (const segment of segments) {
		const next = node[segment];
		if (!next || typeof next !== "object" || Array.isArray(next)) {
			node[segment] = {};
		}
		node = node[segment] as Record<string, unknown>;
	}
	node[last] = value;
}

/**
 * 判定一个值能否写进该控件
 *
 * 返回的是**规范化后**的值(数值字符串 -> 数字、checkbox 去重), 不是原值。
 * group / table / text 不是单值控件, 一律判为不可写。
 */
export function checkValue(control: Control, raw: unknown): ValueCheck {
	switch (control.type) {
		case "input": {
			if (control.valueType === "number") {
				const num = numericValue(raw);
				if (!Number.isFinite(num)) return fail("必须是数字");
				if (control.integer && !Number.isInteger(num)) return fail("必须是整数");
				if (control.min !== undefined && num < control.min) return fail(`不能小于 ${control.min}`);
				if (control.max !== undefined && num > control.max) return fail(`不能大于 ${control.max}`);
				return ok(num);
			}
			if (typeof raw !== "string") return fail("必须是字符串");
			if (control.required && raw.trim() === "") return fail("不能为空");
			return ok(raw);
		}

		case "textarea": {
			if (typeof raw !== "string") return fail("必须是字符串");
			if (control.required && raw.trim() === "") return fail("不能为空");
			return ok(raw);
		}

		case "switch": {
			if (typeof raw !== "boolean") return fail("必须是布尔值");
			return ok(raw);
		}

		case "select": {
			if (typeof raw !== "string") return fail("必须是字符串");
			const allowed = control.items.map((item) => item.value);
			if (!allowed.includes(raw)) return fail(`取值必须在 ${allowed.join(" / ")} 之内`);
			return ok(raw);
		}

		case "checkbox": {
			if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
				return fail("必须是字符串数组");
			}
			// 去重但保持原顺序
			const list = [...new Set(raw as string[])];
			const allowed = new Set(control.items.map((item) => item.value));
			const unknown = list.find((item) => !allowed.has(item));
			if (unknown !== undefined) return fail(`含未知项 "${unknown}"`);
			if (control.required && list.length === 0) return fail("不能为空");
			return ok(list);
		}

		case "slider": {
			if (typeof raw !== "number" || Number.isNaN(raw)) return fail("必须是数字");
			if (control.integer && !Number.isInteger(raw)) return fail("必须是整数");
			if (raw < control.min) return fail(`不能小于 ${control.min}`);
			if (raw > control.max) return fail(`不能大于 ${control.max}`);
			return ok(raw);
		}

		default:
			return fail("不是可写入的单值控件");
	}
}

/**
 * 把从文件读到的值规范化为完整值
 *
 * 未知键丢弃、缺失键补默认值; 类型或取值不合法的项**回落到默认值** ——
 * 值文件被手工改坏时, 不该让整个域起不来。
 */
export function sanitizeLoaded(schema: ConfigRoot, raw: unknown): ConfigValues {
	const out = defaultsOf(schema);
	if (!isPlainObject(raw)) return out;
	sanitizeInto(schema?.controls ?? [], raw, out);
	return out;
}

function sanitizeInto(
	controls: readonly Control[],
	src: Record<string, unknown>,
	holder: Record<string, unknown>,
): void {
	for (const control of controls) {
		if (control.type === "text") continue;
		const has = Object.prototype.hasOwnProperty.call(src, control.id);

		if (control.type === "group") {
			const rawChild = src[control.id];
			const childSrc = has && isPlainObject(rawChild) ? rawChild : {};
			if (!isPlainObject(holder[control.id])) holder[control.id] = {};
			sanitizeInto(control.controls ?? [], childSrc, holder[control.id] as Record<string, unknown>);
			continue;
		}

		if (!has) continue; // 缺省值已由 defaultsOf 填好
		const result = checkValue(control, src[control.id]);
		if (result.ok) holder[control.id] = result.value;
	}
}
