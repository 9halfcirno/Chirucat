/**
 * 配置存储引擎: schema + 值 + 持久化文件
 *
 * `ConfigManager`(插件配置, 宽松写入)与 `SettingsDomain`(框架设置, 严格 patch)
 * 共用这一层: 默认值展开、`coerce`(补默认/丢未知键)、逐字段变更通知、文件绑定与
 * 载入。差异(是否校验、是否脱敏、是否有热应用钩子)留在各自的子类里,
 * 基类里没有"是不是设置"的布尔开关。
 *
 * 值文件统一交给 `JsonFileStore` —— 与期望态存储共用同一套原子写、串行化与
 * revision 守卫。基类不主动监听值文件的外部改动: 大量插件同时启用时, 一份配置
 * 一个 `fs.watch` 会让句柄与事件成倍放大。
 */
import { readProp } from "../utils/readProp";
import {
	JsonFileStore,
	cloneValue,
	deepEqual,
	isPlainObject,
	writeJsonFile,
	type LoadOutcome,
} from "./store";
import type { ConfigRoot, Control } from "./types";

/**
 * 一份配置值。
 * 结构与前端 config-editor.js 的 getValues() 一致:
 * `{ 叶子id: 值, groupId: { ... }, tableId: [{ 子id: 值 }] }`
 */
export type ConfigValues = Record<string, any>;

/** 配置变更回调: key 为发生变化的配置项路径(点号分隔), 如 "offset" / "pro-group.extra" */
export type ConfigChangeHandler = (key: string, value: unknown, oldValue: unknown) => void;

/** 存储容错与初始内容: 由子类显式给出, 基类不猜 */
export interface ConfigBaseOptions {
	/** 日志与错误文案里的主体名, 如 `ConfigManager` */
	label?: string;
	/** 文件缺失时是否顺手创建 (默认 true) */
	createIfMissing?: boolean;
	/** 读取/解析失败时的行为 (默认 throw) */
	onError?: "throw" | "fallback" | "recreate";
	/** 生成初始内容的工厂; 缺省用 schema 默认值 */
	onCreate?: () => ConfigValues;
	/** 读盘规范化; 缺省按 schema `coerce` */
	normalize?: (raw: unknown) => ConfigValues;
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
		} else if (!deepEqual(oldObj[control.id], newObj[control.id])) {
			changed.push(key);
		}
	}
	return changed;
}

export abstract class ConfigBase {
	/** 绑定了值文件时的存储层; 纯内存(未绑定文件)时为 null */
	private readonly store: JsonFileStore<ConfigValues> | null;

	/** 纯内存模式下的配置值(测试/嵌入式用) */
	private memoryData: ConfigValues;

	/** 变更监听器 */
	private readonly watchers = new Set<ConfigChangeHandler>();

	protected readonly label: string;

	constructor(readonly schema: ConfigRoot, readonly file?: string, options: ConfigBaseOptions = {}) {
		this.label = options.label ?? "Config";
		this.memoryData = this.defaults();
		this.store = file
			? new JsonFileStore<ConfigValues>(file, {
				defaults: () => (options.onCreate ? options.onCreate() : this.defaults()),
				normalize: (raw) => (options.normalize
					? options.normalize(raw)
					: this.coerce(this.schema?.controls ?? [], raw)),
				onError: options.onError ?? "throw",
				createIfMissing: options.createIfMissing ?? true,
			})
			: null;
	}

	/**
	 * 当前配置值的只读视图
	 *
	 * 有值文件时返回 store 的深拷贝; 纯内存模式下返回内部对象本身(与原行为一致)。
	 * 直接改这份对象不会生效 —— 写入请走子类的写入入口。
	 */
	get data(): ConfigValues {
		return this.store ? this.store.get() : this.memoryData;
	}

	/* ---------- 默认值 ---------- */

	/**
	 * 单个控件的默认值
	 *
	 * 必须与前端 config-editor.js 的 defaultValueOf 逐条保持一致,
	 * 否则前端 reset 出来的值与后端补齐的值会不同。
	 */
	protected static defaultValueOf(define: Control): unknown {
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
			case "input":
				// 数值输入没有默认值时不能用空串: 它会被当成"填了个非数字"
				if (define.valueType === "number") {
					const num = typeof define.default === "number" ? define.default : Number(define.default);
					return Number.isFinite(num) ? num : (define.min ?? 0);
				}
				return define.default === undefined ? "" : cloneValue(define.default);
			case "text":
				return undefined;
			default:
				return define.default === undefined ? "" : cloneValue(define.default);
		}
	}

	/**
	 * 按控件类型规范化一个已有值
	 *
	 * 目前只有数值输入需要: 数字字符串 -> 数字。无法解析时原样保留,
	 * 由校验报错 —— 基类的写入是宽松的, 这里不替用户决定"坏值该变成什么"。
	 */
	protected static normalizeValue(control: Control, value: unknown): unknown {
		if (
			control.type === "input"
			&& control.valueType === "number"
			&& typeof value === "string"
			&& value.trim() !== ""
		) {
			const num = Number(value);
			if (Number.isFinite(num)) return num;
		}
		return value;
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
				out[control.id] = ConfigBase.defaultValueOf(control);
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
	protected fillRow(columns: readonly Control[], row: Record<string, any>): ConfigValues {
		const out: ConfigValues = {};

		for (const column of columns) {
			if (column.type === "text") continue;
			out[column.id] = ConfigBase.normalizeValue(
				column,
				Object.prototype.hasOwnProperty.call(row, column.id)
					? cloneValue(row[column.id])
					: ConfigBase.defaultValueOf(column),
			);
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
	 * 子类的写入入口触发; 一次变更里每个发生变化的配置项调用一次回调,
	 * 没有变化就不调用。载入不算变更。
	 *
	 * @param handler 变更回调, 参数为 (配置项路径, 新值, 旧值)
	 * @returns 取消监听
	 */
	watch(handler: ConfigChangeHandler): () => void {
		this.watchers.add(handler);
		return () => { this.watchers.delete(handler); };
	}

	/** 对比新旧值, 逐个通知变更; 单个监听器抛错不影响其余监听器与保存流程 */
	protected notifyChanges(oldValues: ConfigValues, newValues: ConfigValues) {
		if (this.watchers.size === 0) return;

		const keys = collectChangedPaths(this.schema?.controls ?? [], oldValues, newValues, "");
		for (const key of keys) {
			const value = readProp(newValues, key);
			const oldValue = readProp(oldValues, key);
			for (const handler of [...this.watchers]) {
				try {
					handler(key, value, oldValue);
				} catch (e) {
					console.error(`${this.label}: 配置变更回调出错 (key="${key}")`, e);
				}
			}
		}
	}

	/* ---------- 载入与写入底座 ---------- */

	/**
	 * 从文件载入配置值
	 *
	 * 文件不存在时按默认值生成一份(目录一并创建);
	 * 读到部分值时, 缺失的键回落到默认值, 未知键丢弃
	 * (规范化由子类通过构造选项 `normalize` 决定)。
	 *
	 * @param file 值文件路径, 缺省用构造时传入的 file
	 */
	async load(file: string = this.file ?? ""): Promise<ConfigValues> {
		if (!this.store) return this.data;
		await this.store.load(file || this.store.file);
		return this.data;
	}

	/**
	 * 从文件载入, 并回报这次载入对值文件做了什么
	 *
	 * `created` / `recovered` 供启动层决定要不要打印初始密码或提示文件被重建。
	 * 纯内存模式没有文件, 恒为"未创建、未恢复"。
	 */
	protected async loadWithOutcome(file: string = this.file ?? ""): Promise<LoadOutcome<ConfigValues>> {
		if (!this.store) return { value: this.data, created: false, recovered: false };
		return this.store.loadOutcome(file || this.store.file);
	}

	/** 用一份新值更新内存并落盘 (子类的写入入口) */
	protected async commitValue(next: ConfigValues): Promise<void> {
		if (this.store) await this.store.commit(next);
		else this.memoryData = next;
	}

	/** 只改内存, 由调用方决定何时落盘 (schema 热更新等) */
	protected replaceValue(next: ConfigValues): void {
		if (this.store) this.store.replace(next);
		else this.memoryData = next;
	}

	/** 把当前内存值写到目标文件 */
	protected async writeCurrent(target: string): Promise<void> {
		if (this.store) {
			await this.store.write(target);
			return;
		}
		await writeJsonFile(target, cloneValue(this.memoryData));
	}

	/** 释放存储层 (子类在 close 时调用) */
	protected closeStore(): void {
		this.store?.close();
	}

	/* ---------- 规范化 ---------- */

	/**
	 * 以 controls 为骨架规范化一份值
	 *
	 * - 只保留 schema 已知的键, 未知键丢弃
	 * - 键缺失时回落到 fallback 的同路径值, 再回落到控件默认值
	 * - group 递归; table 整表替换, 行内用列默认值补全
	 */
	protected coerce(controls: readonly Control[], source?: unknown, fallback?: unknown): ConfigValues {
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

			out[id] = ConfigBase.normalizeValue(
				control,
				hasSrc
					? cloneValue(src[id])
					: hasFb
						? cloneValue(fb[id])
						: ConfigBase.defaultValueOf(control),
			);
		}
		return out;
	}
}
