import type { Control } from "../types";
import type { GroupMeta, OptionItem, SettingSpec, SettingsDefinition } from "./types";

/**
 * 定义 → 投影
 *
 * 设置定义是数据层的真相源; 前端 config-editor 只认 `Control[]`, 所以这里
 * 把定义投影成控件树 —— 单向的、可丢弃的: 改定义就重新投影, 不存在两份定义漂移。
 *
 * 键到控件的映射:
 * - 点号路径的每一层前缀 → `group` (`frontConfig.enableTestLab` → 组 frontConfig)
 * - `string` → input (multiline 时为 textarea; secret 时是密码框)
 * - `number` → 给了 min & max 时是 slider, 否则是 input (后端负责把字符串转成数字)
 * - `boolean` → switch
 * - `enum` → select
 * - `stringList` → 有 items 时是 checkbox, 否则是多行 textarea (按行拆分)
 */

/** 控件树节点: 要么是叶子(有 spec), 要么是分组(有 children) */
interface TreeNode {
	name: string;
	/** 点号路径 */
	path: string;
	spec?: SettingSpec;
	children: Map<string, TreeNode>;
}

/**
 * 把设置定义投影成控件定义数组
 *
 * 顺序与定义中 fields 的声明顺序一致; 分组出现在它首个字段的位置。
 * 可安全地直接交给前端 `createConfigList`。
 */
export function toControls(definition: SettingsDefinition): Control[] {
	const root: TreeNode = { name: "", path: "", children: new Map() };

	for (const [path, spec] of entriesOf(definition)) {
		const segments = path.split(".");
		let node = root;

		for (const [index, segment] of segments.entries()) {
			let child = node.children.get(segment);
			if (!child) {
				const childPath = node.path ? `${node.path}.${segment}` : segment;
				child = { name: segment, path: childPath, children: new Map() };
				node.children.set(segment, child);
			}
			node = child;

			// 末段即叶子, 挂上类型定义
			if (index === segments.length - 1) node.spec = spec;
		}
	}

	return buildControls(root, definition.groups ?? {});
}

/** 按定义展开一份默认值 (嵌套结构, 与控件树产出形状一致) */
export function defaultsOf(definition: SettingsDefinition): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [path, spec] of entriesOf(definition)) {
		writePath(out, path, specDefault(spec));
	}
	return out;
}

/** 一个设置项的默认值 */
export function specDefault(spec: SettingSpec): unknown {
	switch (spec.type) {
		case "string":
			return spec.default ?? "";
		case "number":
			return spec.default ?? spec.min ?? 0;
		case "boolean":
			return spec.default ?? false;
		case "enum":
			return spec.default ?? spec.items[0]!.value;
		case "stringList":
			return [...(spec.default ?? [])];
	}
}

/** 定义中的全部设置项, 保持声明顺序 */
export function entriesOf(definition: SettingsDefinition): [string, SettingSpec][] {
	return Object.entries(definition.fields);
}

/** 路径前缀分组名 → 分组元信息 */
export function groupMetaOf(definition: SettingsDefinition, path: string): GroupMeta | undefined {
	return definition.groups?.[path];
}

/* ---------- 值路径读写 ---------- */

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

/* ---------- 内部 ---------- */

/** 递归把节点树转成控件数组 */
function buildControls(node: TreeNode, groups: Record<string, GroupMeta>): Control[] {
	const controls: Control[] = [];

	for (const child of node.children.values()) {
		if (child.spec) {
			controls.push(leafControl(child.name, child.spec));
			continue;
		}

		const meta = groups[child.path];
		controls.push({
			type: "group",
			id: child.name,
			label: meta?.label ?? child.name,
			...(meta?.desc !== undefined ? { desc: meta.desc } : {}),
			controls: buildControls(child, groups),
		});
	}
	return controls;
}

/** 叶子设置项 → 控件 */
function leafControl(name: string, spec: SettingSpec): Control {
	const label = spec.label ?? name;
	const desc = spec.desc !== undefined ? { desc: spec.desc } : {};
	const required = spec.required !== undefined ? { required: spec.required } : {};

	switch (spec.type) {
		case "string": {
			if (spec.secret) {
				return {
					type: spec.multiline ? "textarea" : "input",
					id: name,
					label,
					default: "",
					placeholder: spec.placeholder ?? "留空表示不修改",
					attr: { type: "password", autocomplete: "new-password", ...readOnlyAttr(spec) },
					...desc,
					...required,
				};
			}
			return {
				type: spec.multiline ? "textarea" : "input",
				id: name,
				label,
				default: spec.default ?? "",
				...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
				...(spec.immutable ? { attr: readOnlyAttr(spec) } : {}),
				...desc,
				...required,
			};
		}

		case "number": {
			// 控件形态: 显式 widget 优先, 否则"给了完整范围就用滑块"
			const useSlider = spec.widget === "slider"
				|| (spec.widget === undefined && spec.min !== undefined && spec.max !== undefined);

			if (useSlider && spec.min !== undefined && spec.max !== undefined) {
				return {
					type: "slider",
					id: name,
					label,
					min: spec.min,
					max: spec.max,
					step: spec.step ?? 1,
					default: Number(specDefault(spec)),
					...desc,
					...required,
				};
			}
			// 没有范围(或显式要求)时用输入框, 后端负责把数字字符串转成数字
			return {
				type: "input",
				id: name,
				label,
				default: String(specDefault(spec)),
				...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
				attr: { inputmode: "numeric", ...readOnlyAttr(spec) },
				...desc,
				...required,
			};
		}

		case "boolean":
			return {
				type: "switch",
				id: name,
				label,
				default: specDefault(spec) === true,
				...desc,
				...required,
			};

		case "enum":
			return {
				type: "select",
				id: name,
				label,
				items: copyItems(spec.items),
				default: String(specDefault(spec)),
				...desc,
				...required,
			};

		case "stringList": {
			if (spec.items) {
				return {
					type: "checkbox",
					id: name,
					label,
					items: copyItems(spec.items),
					default: [...((specDefault(spec) as string[]) ?? [])],
					...desc,
					...required,
				};
			}
			// 无候选集: 多行文本, 一行一项
			return {
				type: "textarea",
				id: name,
				label,
				default: (specDefault(spec) as string[]).join("\n"),
				...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
				...desc,
				...required,
			};
		}
	}
}

/** 定义的 items 是只读的, 投影成控件时要给一份可变副本 */
function copyItems(items: readonly OptionItem[]): OptionItem[] {
	return items.map((item) => ({ label: item.label, value: item.value }));
}

/**
 * immutable 项的只读标记
 *
 * 只加在能靠原生 attr 生效的输入控件上 (input / textarea): config-editor 的
 * select / checkbox / switch / slider 是自绘的, 不认 disabled, 给它们加反而误导。
 * 真正的拦截在后端 (patch 阶段), 这里只是别让用户以为能改。
 */
function readOnlyAttr(spec: SettingSpec): Record<string, unknown> {
	return spec.immutable ? { disabled: "true" } : {};
}
