import path from "node:path";
import { atomicWriteJson } from "../utils/writeFile";
import { readJSON } from "../utils/readJSON";
import { dirCheck } from "../utils/dir-check";
import { readProp } from "../utils/readProp";
import { root } from "../utils/root";
import type { ConfigRoot, Control } from "./types";
import { validateConfig } from "./vaildate-config";

/**
 * 一份配置值。
 * 结构与前端 config-editor.js 的 getValues() 一致:
 * `{ 叶子id: 值, groupId: { ... }, tableId: [{ 子id: 值 }] }`
 */
export type ConfigValues = Record<string, any>;

/** 是否为普通对象 (排除 null 与数组) */
function isPlainObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 深拷贝一份配置值 (配置值只含原始类型 / 数组 / 普通对象) */
function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map(cloneValue) as T;
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
		return out as T;
	}
	return value;
}

/** 递归比较两个配置值 */
function isEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => isEqual(item, b[index]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		return keys.every((key) => isEqual(a[key], b[key]));
	}
	return false;
}

/**
 * 收集发生变化的配置项路径
 *
 * group 递归下去, 报出变化的那一项; table 的行集合作为整体比较
 * (行内改动只报 table 自身的路径)。
 */
function collectChangedPaths(
	controls: readonly Control[],
	oldValues: unknown,
	newValues: unknown,
	prefix: string,
): string[] {
	const oldObj = isPlainObject(oldValues) ? oldValues : {};
	const newObj = isPlainObject(newValues) ? newValues : {};
	const changed: string[] = [];

	for (const control of controls) {
		if (control.type === "text") continue;
		const key = prefix ? `${prefix}.${control.id}` : control.id;

		if (control.type === "group") {
			changed.push(...collectChangedPaths(control.controls ?? [], oldObj[control.id], newObj[control.id], key));
		} else if (!isEqual(oldObj[control.id], newObj[control.id])) {
			changed.push(key);
		}
	}
	return changed;
}

/** 配置变更回调: key 为发生变化的配置项路径(点号分隔), 如 "offset" / "pro-group.extra" */
export type ConfigChangeHandler = (key: string, value: unknown, oldValue: unknown) => void;

/**
 * 配置管理器: 控件定义(schema) + 配置值(data) + 持久化文件(file)
 *
 * 值文件只存值, 定义文件(控件的 controls / default)由插件自带且只读 ——
 * 定义文件里通常带注释, 一旦由程序回写就会丢失。
 */
export class ConfigManager {
	/** 当前配置值 (内存态, 改动需显式 save / update 才落盘) */
	data: ConfigValues;

	/** 变更监听器 */
	private readonly watchers = new Set<ConfigChangeHandler>();

	constructor(readonly schema: ConfigRoot, readonly file?: string) {
		this.data = this.defaults();
	}

	/* ---------- 默认值 ---------- */

	/**
	 * 单个控件的默认值。
	 *
	 * 必须与前端 config-editor.js 的 defaultValueOf 逐条保持一致,
	 * 否则前端 reset 出来的值与后端补齐的值会不同。
	 */
	private static defaultValueOf(define: Control): unknown {
		switch (define.type) {
			case "group":
				return {};
			case "table":
				return [];
			case "checkbox":
				return Array.isArray(define.default) ? cloneValue(define.default) : [];
			case "switch":
				return define.default === true;
			case "slider":
				return typeof define.default === "number" ? define.default : (define.min ?? 0);
			case "text":
				return undefined;
			default:
				return define.default === undefined ? "" : cloneValue(define.default);
		}
	}

	/**
	 * 按控件定义展开一份默认值
	 *
	 * table 的初始行来自控件自身的 default; 未提供 default 时是空表。
	 */
	defaults(controls: readonly Control[] = this.schema?.controls ?? []): ConfigValues {
		const out: ConfigValues = {};

		for (const control of controls) {
			if (control.type === "text") continue; // text 只作说明, 不产生值

			if (control.type === "group") {
				out[control.id] = this.defaults(control.controls ?? []);
			} else if (control.type === "table") {
				out[control.id] = (control.default ?? []).map((row) =>
					this.fillRow(control.controls ?? [], isPlainObject(row) ? row : {}),
				);
			} else {
				out[control.id] = ConfigManager.defaultValueOf(control);
			}
		}
		return out;
	}

	/**
	 * 用列控件的默认值补全一行
	 *
	 * 前端 addRow 只为 default 里给出的键赋值, 其余键在构建控件时写入自身默认值,
	 * 因此行对象的键总是完整的列集合 —— 这里保持一致。
	 */
	private fillRow(columns: readonly Control[], row: Record<string, any>): ConfigValues {
		const out: ConfigValues = {};

		for (const column of columns) {
			if (column.type === "text") continue;
			out[column.id] = Object.prototype.hasOwnProperty.call(row, column.id)
				? cloneValue(row[column.id])
				: ConfigManager.defaultValueOf(column);
		}
		return out;
	}

	/* ---------- 取值 ---------- */

	/**
	 * 取某个配置项的值
	 *
	 * 支持点号路径, 数组用数字下标: `get("pro-group.group-controls.0.enable")`。
	 * 依次尝试 当前值 → 默认值 → fallback; 返回的是内部引用, 需要副本请自行拷贝。
	 *
	 * @param key 属性路径
	 * @param fallback 当前值与默认值都未命中时的返回值
	 */
	get<T = unknown>(key: string, fallback?: T): T {
		const value = readProp(this.data, key);
		if (value !== undefined) return value as T;

		const preset = readProp(this.defaults(), key);
		return (preset !== undefined ? preset : fallback) as T;
	}

	/** 当前配置值的一份深拷贝 (供外部安全地读取整份配置) */
	values(): ConfigValues {
		return cloneValue(this.data);
	}

	/* ---------- 变更监听 ---------- */

	/**
	 * 监听配置变更
	 *
	 * 仅在 update() 改动配置时触发(load 视为载入, 不算变更);
	 * 一次 update 里每个发生变化的配置项调用一次回调, 没有变化就不调用。
	 *
	 * @param handler 变更回调, 参数为 (配置项路径, 新值, 旧值)
	 * @returns 取消监听
	 */
	watch(handler: ConfigChangeHandler): () => void {
		this.watchers.add(handler);
		return () => { this.watchers.delete(handler); };
	}

	/** 对比新旧值, 逐个通知变更; 单个监听器抛错不影响其余监听器与保存流程 */
	private notifyChanges(oldValues: ConfigValues, newValues: ConfigValues) {
		if (this.watchers.size === 0) return;

		const keys = collectChangedPaths(this.schema?.controls ?? [], oldValues, newValues, "");
		for (const key of keys) {
			const value = readProp(newValues, key);
			const oldValue = readProp(oldValues, key);
			for (const handler of [...this.watchers]) {
				try {
					handler(key, value, oldValue);
				} catch (e) {
					console.error(`ConfigManager: 配置变更回调出错 (key="${key}")`, e);
				}
			}
		}
	}

	/* ---------- 载入与保存 ---------- */

	/**
	 * 从文件载入配置值
	 *
	 * 文件不存在时按 schema 默认值生成一份(目录一并创建);
	 * 读到部分值时, 缺失的键回落到默认值, 未知键丢弃。
	 * 文件存在但解析失败(语法错误、权限等)照常抛出, 不静默覆盖。
	 *
	 * @param file 值文件路径, 缺省用构造时传入的 file
	 */
	async load(file: string = this.file ?? ""): Promise<ConfigValues> {
		if (!file) return this.data;

		let loaded: unknown;
		try {
			loaded = await readJSON(file);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			loaded = this.defaults();
			await dirCheck(path.dirname(file));
			await atomicWriteJson(file, loaded);
		}

		this.data = this.coerce(this.schema?.controls ?? [], loaded);
		return this.data;
	}

	/**
	 * 用一份提交值更新配置并落盘
	 *
	 * 前端 getValues() 不产出隐藏项, 所以不能直接用提交值覆盖:
	 * 提交中缺失的已知键保留旧值, 隐藏项不会被抹掉。
	 * (table 例外: 用户提交的行集合就是权威, 整表替换)
	 *
	 * @param submitted 前端提交的配置值
	 */
	async update(submitted: unknown): Promise<ConfigValues> {
		const before = this.data;
		this.data = this.coerce(this.schema?.controls ?? [], submitted, this.data);
		await this.save();
		this.notifyChanges(before, this.data);
		return this.data;
	}

	/**
	 * 以 controls 为骨架规范化一份值
	 *
	 * - 只保留 schema 已知的键, 未知键丢弃
	 * - 键缺失时回落到 fallback 的同路径值, 再回落到控件默认值
	 * - group 递归; table 整表替换, 行内用列默认值补全
	 */
	private coerce(controls: readonly Control[], source?: unknown, fallback?: unknown): ConfigValues {
		const src = isPlainObject(source) ? source : {};
		const fb = isPlainObject(fallback) ? fallback : {};
		const out: ConfigValues = {};

		for (const control of controls) {
			if (control.type === "text") continue;
			const id = control.id;
			const hasSrc = Object.prototype.hasOwnProperty.call(src, id);
			const hasFb = Object.prototype.hasOwnProperty.call(fb, id);

			if (control.type === "group") {
				out[id] = this.coerce(
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
					this.fillRow(control.controls ?? [], isPlainObject(row) ? row : {}),
				);
				continue;
			}

			out[id] = hasSrc
				? cloneValue(src[id])
				: hasFb
					? cloneValue(fb[id])
					: ConfigManager.defaultValueOf(control);
		}
		return out;
	}

	/**
	 * 校验一份配置值是否符合控件定义
	 * @param config 待校验的值, 缺省校验当前值
	 */
	vaildate(config: unknown = this.data) {
		return validateConfig(this.schema, config);
	}

	/**
	 * 保存到文件: 先建目录, 再原子写入
	 * @param file 目标文件, 缺省用构造时传入的 file
	 */
	async save(file?: string) {
		const target = file ?? this.file;
		if (!target) throw new Error("ConfigManager 未绑定配置文件, 无法保存");
		await dirCheck(path.dirname(target));
		await atomicWriteJson(target, this.data);
	}

	/* ---------- 路径约定 ---------- */

	/**
	 * 插件配置值文件路径: `<Bot目录>/configs/plugins/<插件id>.json`
	 * @param botPath Bot目录(BotConfig.path); 相对路径以项目根为基准
	 * @param pluginId 插件id
	 */
	static fileForPlugin(botPath: string, pluginId: string): string {
		return path.resolve(root, botPath, "configs", "plugins", `${pluginId}.json`);
	}
}
