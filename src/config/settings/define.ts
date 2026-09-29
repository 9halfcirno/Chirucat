import type { OptionItem, SettingSpec, SettingsDefinition } from "./types";

/**
 * 声明一份设置定义
 *
 * 只做"定义本身是否写对"的检查并原样返回 —— 定义写错属于编程错误,
 * 应当在启动时立刻炸掉, 而不是等到用户点保存才发现。
 *
 * 检查项:
 * - 字段键是合法的点号路径 (无空白、无空段、无首尾点)
 * - 控件类型受支持, 且 default 与该类型相符
 * - enum 的 items 非空、value 唯一, default 必须是其中一个取值
 * - stringList 的 default / items 互相自洽
 * - 数值项的 min/max/step 自洽
 * - groups 里声明的分组确实有字段落到它下面
 *
 * @param definition 设置定义
 * @throws Error 定义不合法时
 */
export function defineSettings(definition: SettingsDefinition): SettingsDefinition {
	if (!definition || typeof definition !== "object") {
		throw new Error("设置定义不合法: 必须是一个对象");
	}
	if (!definition.fields || typeof definition.fields !== "object" || Array.isArray(definition.fields)) {
		throw new Error("设置定义不合法: 缺少 fields 对象");
	}

	const keys = Object.keys(definition.fields);
	if (keys.length === 0) {
		throw new Error("设置定义不合法: fields 不能为空");
	}

	for (const key of keys) {
		assertPath(key);
		assertSpec(key, definition.fields[key]!);
	}

	// 字段键之间不能互为前缀: 一个键既当叶子又当分组, 投影时子字段会被静默丢掉
	const sorted = [...keys].sort();
	for (let i = 1; i < sorted.length; i++) {
		const previous = sorted[i - 1]!;
		const current = sorted[i]!;
		if (current.startsWith(`${previous}.`)) {
			throw new Error(`设置定义不合法: 字段 "${previous}" 与 "${current}" 互为前缀`);
		}
	}

	for (const groupKey of Object.keys(definition.groups ?? {})) {
		assertPath(groupKey);
		const used = keys.some((key) => key.startsWith(`${groupKey}.`));
		if (!used) throw new Error(`设置定义不合法: 分组 "${groupKey}" 下没有任何字段`);
	}

	return definition;
}

/* ---------- 校验小工具 ---------- */

/** 字段键必须是合法的点号路径 */
function assertPath(key: string): void {
	if (!key) throw new Error("设置定义不合法: 字段键不能为空");
	if (/\s/.test(key)) throw new Error(`设置定义不合法: 字段键不能含空白: "${key}"`);
	if (key.startsWith(".") || key.endsWith(".")) {
		throw new Error(`设置定义不合法: 字段键不能以点号开头或结尾: "${key}"`);
	}
	if (key.includes("..")) throw new Error(`设置定义不合法: 字段键含空路径段: "${key}"`);
}

/** 单个设置项的类型与默认值 */
function assertSpec(path: string, spec: SettingSpec): void {
	if (!spec || typeof spec !== "object") {
		throw new Error(`设置定义不合法: 字段 "${path}" 缺少类型定义`);
	}

	// secret 的"对外脱敏 / 空串表示不修改"只对字符串有意义
	if (spec.secret && spec.type !== "string") {
		throw new Error(`设置定义不合法: 字段 "${path}" 的 secret 只能用在 string 类型上`);
	}

	switch (spec.type) {
		case "string": {
			if (spec.default !== undefined && typeof spec.default !== "string") {
				throw new Error(`设置定义不合法: 字段 "${path}" 的默认值必须是字符串`);
			}
			return;
		}

		case "number": {
			if (spec.default !== undefined && !Number.isFinite(spec.default)) {
				throw new Error(`设置定义不合法: 字段 "${path}" 的默认值必须是有限数字`);
			}
			for (const bound of ["min", "max", "step"] as const) {
				const value = spec[bound];
				if (value !== undefined && !Number.isFinite(value)) {
					throw new Error(`设置定义不合法: 字段 "${path}" 的 ${bound} 必须是有限数字`);
				}
			}
			if (spec.step !== undefined && spec.step <= 0) {
				throw new Error(`设置定义不合法: 字段 "${path}" 的 step 必须大于 0`);
			}
			if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
				throw new Error(`设置定义不合法: 字段 "${path}" 的 min 不能大于 max`);
			}
			if (spec.default !== undefined) {
				if (spec.integer && !Number.isInteger(spec.default)) {
					throw new Error(`设置定义不合法: 字段 "${path}" 声明为整数, 默认值必须是整数`);
				}
				if (spec.min !== undefined && spec.default < spec.min) {
					throw new Error(`设置定义不合法: 字段 "${path}" 的默认值小于 min`);
				}
				if (spec.max !== undefined && spec.default > spec.max) {
					throw new Error(`设置定义不合法: 字段 "${path}" 的默认值大于 max`);
				}
			}
			return;
		}

		case "boolean": {
			if (spec.default !== undefined && typeof spec.default !== "boolean") {
				throw new Error(`设置定义不合法: 字段 "${path}" 的默认值必须是布尔值`);
			}
			return;
		}

		case "enum": {
			const values = assertItems(path, spec.items);
			if (spec.default !== undefined && !values.includes(spec.default)) {
				throw new Error(`设置定义不合法: 字段 "${path}" 的默认值不在 items 中`);
			}
			return;
		}

		case "stringList": {
			if (spec.items !== undefined) assertItems(path, spec.items);
			const allowed = spec.items ? new Set(spec.items.map((item) => item.value)) : null;
			for (const item of spec.default ?? []) {
				if (typeof item !== "string") {
					throw new Error(`设置定义不合法: 字段 "${path}" 的默认值必须是字符串数组`);
				}
				if (allowed && !allowed.has(item)) {
					throw new Error(`设置定义不合法: 字段 "${path}" 的默认值含未知项 "${item}"`);
				}
			}
			return;
		}

		default: {
			const type = (spec as { type?: unknown }).type;
			throw new Error(`设置定义不合法: 字段 "${path}" 的类型 "${String(type)}" 不受支持`);
		}
	}
}

/** 校验选项集并返回全部取值 */
function assertItems(path: string, items: readonly OptionItem[] | undefined): string[] {
	if (!Array.isArray(items) || items.length === 0) {
		throw new Error(`设置定义不合法: 字段 "${path}" 必须提供非空的 items`);
	}

	const seen = new Set<string>();
	for (const item of items) {
		if (!item || typeof item.value !== "string" || typeof item.label !== "string") {
			throw new Error(`设置定义不合法: 字段 "${path}" 的 items 项必须是 { label, value } 且均为字符串`);
		}
		if (seen.has(item.value)) {
			throw new Error(`设置定义不合法: 字段 "${path}" 的 items 含重复取值 "${item.value}"`);
		}
		seen.add(item.value);
	}
	return [...seen];
}
