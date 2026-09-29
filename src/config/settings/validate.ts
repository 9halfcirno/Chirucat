import { readProp } from "../../utils/readProp";
import { cloneValue, deepEqual, isPlainObject } from "../store";
import { defaultsOf, entriesOf, specDefault, writePath } from "./compile";
import {
	SettingsError,
	type SettingFieldError,
	type SettingSpec,
	type SettingsDefinition,
} from "./types";

/**
 * patch 的校验与规范化
 *
 * 前端提交的是一份"改动"(patch), 不是完整值:
 * - 只校验并写入提交里出现的字段, 未提交的字段保留原值
 * - 未知字段直接拒绝 —— 正常路径下不可能出现(控件树就是这个定义的投影),
 *   出现即说明前后端定义不一致, 静默丢弃会把问题藏起来
 * - 数值接受数字字符串 (数字项没有范围时投影成输入框, 前端只能给字符串)
 * - 敏感字段的空串表示"不修改", null 表示"清除" (回落默认值)
 */

export interface PatchOutcome {
	/** 合并后的完整值 */
	values: Record<string, unknown>;
	/** 本次真正发生变化的字段路径 */
	changed: string[];
	/** 其中需要重启才生效的字段路径 */
	restartRequired: string[];
}

/**
 * 校验一份 patch 并合并到当前值
 *
 * @param definition 设置定义
 * @param current 当前完整值 (内存态)
 * @param input 前端提交的 patch (嵌套对象或点号键皆可)
 * @throws SettingsError 存在字段级错误时, details 里带上每一条
 */
export function coercePatch(
	definition: SettingsDefinition,
	current: Record<string, unknown>,
	input: unknown,
): PatchOutcome {
	if (!isPlainObject(input)) {
		throw new SettingsError("设置必须是一个对象");
	}

	const fields = new Map(entriesOf(definition));
	const prefixes = collectPrefixes(fields);
	const submitted = new Map<string, unknown>();
	const errors: SettingFieldError[] = [];

	flatten(input, "", submitted, fields, prefixes, errors);

	const next = cloneValue(current);
	const changed: string[] = [];

	for (const [path, spec] of fields) {
		if (!submitted.has(path)) continue;

		const raw = submitted.get(path);
		const label = spec.label ?? path;

		// 未提交 / 敏感字段留空: 保留原值
		if (raw === undefined) continue;
		if (spec.secret && raw === "") continue;

		// 敏感字段显式清除: 回落默认值
		const candidate = spec.secret && raw === null ? specDefault(spec) : raw;
		const result = normaliseValue(spec, candidate);
		if (!result.ok) {
			errors.push({ path, label, message: result.message });
			continue;
		}

		const before = readProp(next, path);

		// immutable 只拒绝"改成别的值"; 提交等值属于无变化, 走下面的短路
		if (spec.immutable && !deepEqual(before, result.value)) {
			errors.push({ path, label, message: `${label} 不可修改` });
			continue;
		}
		if (deepEqual(before, result.value)) continue;

		writePath(next, path, result.value);
		changed.push(path);
	}

	if (errors.length) {
		const detail = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
		throw new SettingsError(`设置校验未通过: ${detail}`, errors);
	}

	return {
		values: next,
		changed,
		restartRequired: changed.filter((path) => fields.get(path)?.restart === true),
	};
}

/**
 * 把一份从文件读到的值规范化为完整值
 *
 * - 未知键丢弃, 缺失键补默认值 (与控件树的形状保持一致)
 * - 类型或取值不合法的项回落到默认值: 值文件被手工改坏时, 不该让整个域起不来
 *
 * @param definition 设置定义
 * @param raw 文件里读到的原始对象
 */
export function normalizeValues(
	definition: SettingsDefinition,
	raw: unknown,
): Record<string, unknown> {
	const out = defaultsOf(definition);
	if (!isPlainObject(raw)) return out;

	for (const [path, spec] of entriesOf(definition)) {
		const value = readProp(raw, path);
		if (value === undefined) continue;

		const result = normaliseValue(spec, value);
		if (result.ok) writePath(out, path, result.value);
	}
	return out;
}

/* ---------- 展开提交值 ---------- */

/** 收集所有设置项路径的前缀 (如 "frontConfig" 之于 "frontConfig.enableTestLab") */
function collectPrefixes(fields: Map<string, SettingSpec>): Set<string> {
	const prefixes = new Set<string>();

	for (const path of fields.keys()) {
		const segments = path.split(".");
		let prefix = "";
		// 最后一段是叶子本身, 只在它之前的前缀中登记
		for (let i = 0; i < segments.length - 1; i++) {
			prefix = prefix ? `${prefix}.${segments[i]}` : segments[i]!;
			prefixes.add(prefix);
		}
	}
	return prefixes;
}

/**
 * 把提交的 patch 展开成"点号路径 → 值"
 *
 * 只有确实是某个设置项路径前缀的分组才继续下钻 —— 否则 `{"unknown": {}}`
 * 这种空壳会一路递归到底, 既不报未知项也不产生改动。
 */
function flatten(
	input: Record<string, unknown>,
	prefix: string,
	out: Map<string, unknown>,
	fields: Map<string, SettingSpec>,
	prefixes: Set<string>,
	errors: SettingFieldError[],
): void {
	for (const [key, value] of Object.entries(input)) {
		const path = prefix ? `${prefix}.${key}` : key;

		if (!key) {
			errors.push({ path, label: key, message: "设置项的键不能为空" });
			continue;
		}
		if (fields.has(path)) {
			out.set(path, value);
			continue;
		}
		if (isPlainObject(value) && prefixes.has(path)) {
			flatten(value, path, out, fields, prefixes, errors);
			continue;
		}
		errors.push({ path, label: key, message: `未知的设置项 "${path}"` });
	}
}

/* ---------- 单个值 ---------- */

type NormaliseResult = { ok: true; value: unknown } | { ok: false; message: string };

function ok(value: unknown): NormaliseResult {
	return { ok: true, value };
}

function fail(message: string): NormaliseResult {
	return { ok: false, message };
}

/** 按类型校验并规范化一个值 */
function normaliseValue(spec: SettingSpec, raw: unknown): NormaliseResult {
	switch (spec.type) {
		case "string": {
			if (typeof raw !== "string") return fail("必须是字符串");
			if (spec.required && raw.trim() === "") return fail("不能为空");
			return ok(raw);
		}

		case "number": {
			// 输入框给出的是字符串, 这里统一转成数字
			const num = typeof raw === "number"
				? raw
				: (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN);

			if (!Number.isFinite(num)) return fail("必须是数字");
			if (spec.integer && !Number.isInteger(num)) return fail("必须是整数");
			if (spec.min !== undefined && num < spec.min) return fail(`不能小于 ${spec.min}`);
			if (spec.max !== undefined && num > spec.max) return fail(`不能大于 ${spec.max}`);
			return ok(num);
		}

		case "boolean": {
			if (typeof raw !== "boolean") return fail("必须是布尔值");
			return ok(raw);
		}

		case "enum": {
			if (typeof raw !== "string") return fail("必须是字符串");
			const allowed = spec.items.map((item) => item.value);
			if (!allowed.includes(raw)) {
				return fail(`取值必须在 ${allowed.join(" / ")} 之内`);
			}
			return ok(raw);
		}

		case "stringList": {
			let list: string[];

			if (Array.isArray(raw)) {
				if (!raw.every((item) => typeof item === "string")) {
					return fail("必须是字符串数组");
				}
				list = [...(raw as string[])];
			} else if (typeof raw === "string") {
				// 无候选集时投影成多行文本, 一行一项
				list = raw.split("\n").map((line) => line.trim()).filter(Boolean);
			} else {
				return fail("必须是字符串数组");
			}

			// 去重但保持原顺序
			list = [...new Set(list)];

			if (spec.items) {
				const allowed = new Set(spec.items.map((item) => item.value));
				const unknown = list.find((item) => !allowed.has(item));
				if (unknown !== undefined) return fail(`含未知项 "${unknown}"`);
			}
			if (spec.required && list.length === 0) return fail("不能为空");
			return ok(list);
		}

		default: {
			// 定义已由 defineSettings 卡住类型, 这里只是防御: 绝不把 undefined
			// 当成校验结果向上传
			const type = (spec as { type?: unknown }).type;
			return fail(`不支持的设置项类型 "${String(type)}"`);
		}
	}
}
