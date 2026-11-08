import Logger from "../../utils/logger";
import { readProp } from "../../utils/readProp";
import { ConfigBase } from "../base";
import { checkValue, defaultValueOf, sanitizeLoaded, writePath } from "../schema";
import { cloneValue, deepEqual, isPlainObject } from "../store";
import type { ConfigRoot, ConfigValues, Control } from "../types";
import {
	SettingsError,
	type SettingFieldError,
	type SettingsLoadAllResult,
	type SettingsLoadResult,
	type SettingsPatchResult,
	type SettingsSnapshot,
} from "./types";

const logger = new Logger("Settings");

export interface SettingsDomainOptions<T extends Record<string, unknown> = Record<string, unknown>> {
	/** 控件定义 (真相源) */
	schema: ConfigRoot;
	/** 值文件路径 */
	file: string;
	/**
	 * 应用钩子
	 *
	 * 校验与落盘成功后调用, 收到的是本次真正变化的字段 —— 且**已剔除 restart 字段**:
	 * 需要重启才生效的项在运行期没有意义, 不交给域去"假装应用"。
	 * 载入完成后也会调用一次, 此时 `changed` 为空数组, 用于把值同步给运行中的对象。
	 *
	 * 钩子抛错不回滚已落盘的值, 调用方会收到"已保存但热应用失败"的错误。
	 */
	apply?: (values: T, changed: string[]) => void | Promise<void>;
	/**
	 * 值文件缺失或损坏重建时生成初始内容的工厂; 缺省取 schema 默认值
	 *
	 * 定义里的 `default` 表达的是"字段缺省值", 但有的文件首次生成需要一次性的
	 * 随机内容(如 WebUI 的初始密码), 这种值写不进定义 —— 交给本钩子, 让
	 * "首次生成什么"也只有 schema 这一个真相源。
	 */
	onCreate?: () => ConfigValues;
	/**
	 * 值文件损坏时的行为, 缺省 `recreate`(备份原文件后按默认值重建)
	 *
	 * 框架自身的值文件可重建; 但 `bot:<id>` 域里 `id` 同时是目录名与索引键,
	 * 默认值是空串, 重建会造出身份不明的 Bot —— 那里必须显式传 `throw`。
	 */
	onError?: "throw" | "fallback" | "recreate";
}

/**
 * 一个框架设置域: schema + 值文件 + 严格写入 + 热应用钩子
 *
 * 存储、默认值与载入规范化都在 `ConfigBase`; 这里只加框架设置特有的策略:
 *
 * - `patch` 是**校验与写入原子的**: 未知键直接拒绝、逐字段校验、敏感字段语义、
 *   `immutable` 拦截; 校验不过一个字节都不写
 * - `read` 返回脱敏后的快照; `get` 是明文内部通道
 * - 写入成功后调 `apply`(restart 字段不进)
 */
export class SettingsDomain<T extends Record<string, unknown> = Record<string, unknown>> extends ConfigBase {
	private readonly options: SettingsDomainOptions<T>;

	constructor(readonly id: string, options: SettingsDomainOptions<T>) {
		super(options.schema, options.file, {
			label: `Settings(${id})`,
			onError: options.onError ?? "recreate",
			createIfMissing: true,
			...(options.onCreate ? { onCreate: options.onCreate } : {}),
			// 读盘坏值回落默认值, 而不是让整个域起不来
			normalize: (raw) => sanitizeLoaded(options.schema, raw),
		});
		this.options = options;
	}

	/**
	 * 当前值 (含敏感字段明文), 返回深拷贝
	 *
	 * 这是**内部通道**, 供框架自身使用(如 WebUIServer 读监听端口与密码);
	 * 任何面向网络返回的地方都必须走 `read()` —— 那一个才是脱敏的。
	 */
	get(): T {
		return this.data as T;
	}

	/**
	 * 从文件载入; 文件缺失时按 schema 生成默认值, 损坏时备份后重建
	 *
	 * 返回载入结果而不只是值: `created` / `recovered` 交给启动层打日志。
	 */
	async load(): Promise<SettingsLoadResult<T>> {
		const outcome = await this.loadWithOutcome();
		// 载入也走 apply(空改动): 与热应用是同一件事, 只是没有字段变化
		await this.options.apply?.(outcome.value as T, []);
		return {
			values: this.get(),
			created: outcome.created,
			recovered: outcome.recovered,
			...(outcome.backupFile ? { backupFile: outcome.backupFile } : {}),
		};
	}

	/** 对外快照: 控件定义 + 脱敏后的值, 供 WebUI 直接渲染 */
	read(): SettingsSnapshot {
		return {
			// ConfigRoot 形状: 前端 createConfigList 读 define.controls
			define: this.schema,
			values: masked(this.schema, this.data),
		};
	}

	/**
	 * 应用一份 patch
	 *
	 * 流程: 校验 → 合并 → 落盘 → 热应用。任一字段校验失败都不写盘;
	 * 没有字段发生变化时不写盘、不调钩子, 直接返回空改动。
	 */
	async patch(input: unknown): Promise<SettingsPatchResult> {
		if (!isPlainObject(input)) throw new SettingsError("设置必须是一个对象");

		const controls = new Map<string, Control>();
		const submitted = new Map<string, unknown>();
		const errors: SettingFieldError[] = [];
		const flat = flattenControlPaths(this.schema?.controls ?? []);
		flattenPatch(this.schema?.controls ?? [], input, "", flat, controls, submitted, errors);

		const next = cloneValue(this.data);
		const changed: string[] = [];
		const restartRequired: string[] = [];

		for (const [path, control] of controls) {
			const raw = submitted.get(path);
			const label = control.label ?? path;

			// 未提交 / 敏感字段留空: 保留原值
			if (raw === undefined) continue;
			if (control.type === "input" && control.secret && raw === "") continue;

			// 敏感字段显式清除: 回落默认值
			const candidate = control.type === "input" && control.secret && raw === null
				? defaultValueOf(control)
				: raw;

			const result = checkValue(control, candidate);
			if (!result.ok) {
				errors.push({ path, label, message: result.message });
				continue;
			}

			const previous = readProp(next, path);

			// immutable 只拒绝"改成别的值"; 提交等值属于无变化, 走下面的短路
			if (isImmutable(control) && !deepEqual(previous, result.value)) {
				errors.push({ path, label, message: `${label} 不可修改` });
				continue;
			}
			if (deepEqual(previous, result.value)) continue;

			writePath(next, path, result.value);
			changed.push(path);
			if (isRestart(control)) restartRequired.push(path);
		}

		if (errors.length) {
			const detail = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
			throw new SettingsError(`设置校验未通过: ${detail}`, errors);
		}

		if (changed.length === 0) {
			return { values: masked(this.schema, next), changed: [], restartRequired: [] };
		}

		await this.commitValue(next);

		const hot = changed.filter((path) => !restartRequired.includes(path));
		if (hot.length > 0 && this.options.apply) {
			try {
				await this.options.apply(next as T, hot);
			} catch (e) {
				// 值已经落盘, 不回滚: 只把"热应用没成功"这件事明确报给调用方
				logger.error(`设置热应用失败 (domain=${this.id})`, e);
				// 错误对象常被序列化后上报或落日志: outcome 必须是脱敏的那一份
				throw new SettingsApplyError(
					`设置已保存, 但热应用失败: ${e instanceof Error ? e.message : String(e)}`,
					{
						values: masked(this.schema, next),
						changed,
						restartRequired,
					},
				);
			}
		}

		return {
			values: masked(this.schema, next),
			changed,
			restartRequired,
		};
	}

	/** 停止并释放存储; 幂等 */
	close(): void {
		this.closeStore();
	}
}

/**
 * 值已落盘但热应用钩子失败
 *
 * `outcome` 是**脱敏后**的 patch 结果: 异常常被序列化后上报或落日志,
 * 明文敏感值不得随它外流。
 */
export class SettingsApplyError extends Error {
	constructor(message: string, readonly outcome: SettingsPatchResult) {
		super(message);
		this.name = "SettingsApplyError";
	}
}

/** 按定义把所有敏感字段抹成空串 */
function masked(schema: ConfigRoot, values: ConfigValues): ConfigValues {
	const out = cloneValue(values) as ConfigValues;
	maskInto(schema?.controls ?? [], out);
	return out;
}

/** 策略标记只声明在部分控件上, 统一在这里取, 避免每处都写 `"x" in control` */
function isImmutable(control: Control): boolean {
	return "immutable" in control && control.immutable === true;
}

function isRestart(control: Control): boolean {
	return "restart" in control && control.restart === true;
}

function maskInto(controls: readonly Control[], holder: ConfigValues): void {
	for (const control of controls) {
		if (control.type === "group") {
			const child = holder[control.id];
			if (isPlainObject(child)) maskInto(control.controls ?? [], child);
		} else if (control.type === "input" && control.secret) {
			holder[control.id] = "";
		}
	}
}

/**
 * 把控件树展开成"点号路径 → 控件"
 *
 * patch 同时接受嵌套对象与点号键 (历史调用方两种都在用), 点号键靠这张表解析。
 */
function flattenControlPaths(
	controls: readonly Control[],
	prefix = "",
	out: Map<string, Control> = new Map(),
): Map<string, Control> {
	for (const control of controls) {
		if (control.type === "text") continue;
		const path = prefix ? `${prefix}.${control.id}` : control.id;
		out.set(path, control);
		if (control.type === "group") flattenControlPaths(control.controls ?? [], path, out);
	}
	return out;
}

/**
 * 把提交的 patch 展开成"点号路径 → 控件 / 值"
 *
 * 只有确实是某个控件前缀的 group 才继续下钻; 未知键直接拒绝 ——
 * 正常路径下不可能出现(控件树就是 schema 本身), 出现即说明前后端定义不一致。
 */
function flattenPatch(
	controls: readonly Control[],
	input: Record<string, unknown>,
	prefix: string,
	flat: Map<string, Control>,
	paths: Map<string, Control>,
	values: Map<string, unknown>,
	errors: SettingFieldError[],
): void {
	for (const [key, value] of Object.entries(input)) {
		const path = prefix ? `${prefix}.${key}` : key;

		if (!key) {
			errors.push({ path, label: key, message: "设置项的键不能为空" });
			continue;
		}

		// 先找直接子控件; 找不到再按完整点号路径找 (兼容扁平提交)
		const control = (controls.find((item) => item.type !== "text" && item.id === key)
			?? flat.get(path)) as Control | undefined;
		if (!control) {
			errors.push({ path, label: key, message: `未知的设置项 "${path}"` });
			continue;
		}

		if (control.type === "group") {
			if (!isPlainObject(value)) {
				const label = control.label ?? key;
				errors.push({ path, label, message: `${label} 必须是对象` });
				continue;
			}
			flattenPatch(control.controls ?? [], value, path, flat, paths, values, errors);
			continue;
		}

		// 框架设置不走 table: 整表替换没有对应的严格写入入口
		if (control.type === "table") {
			const label = control.label ?? key;
			errors.push({ path, label, message: `${label} 不支持 table 控件` });
			continue;
		}

		paths.set(path, control);
		values.set(path, value);
	}
}

/**
 * 启动时检查一份 schema 能否被严格 patch
 *
 * 只查"写错会在运行期才炸"的项: 重复 id、缺 id、table。类型与语义标记由
 * TypeScript 在域定义处保证。
 */
function assertPatchableSchema(schema: ConfigRoot, id: string): void {
	if (!schema || !Array.isArray(schema.controls) || schema.controls.length === 0) {
		throw new Error(`设置域 ${id} 的 schema 不合法: 缺少 controls 数组`);
	}
	assertControls(schema.controls, id, "");
}

function assertControls(controls: readonly Control[], id: string, prefix: string): void {
	const seen = new Set<string>();

	for (const control of controls) {
		if (control.type === "text") continue;
		if (!control.id) {
			throw new Error(`设置域 ${id} 的 schema 不合法: ${prefix || "(根)"} 下的控件缺少 id`);
		}

		const path = prefix ? `${prefix}.${control.id}` : control.id;
		if (seen.has(control.id)) {
			throw new Error(`设置域 ${id} 的 schema 不合法: 重复控件 "${path}"`);
		}
		seen.add(control.id);

		if (control.type === "table") {
			throw new Error(`设置域 ${id} 的 schema 不合法: 不支持 table ("${path}")`);
		}
		if (control.type === "group") assertControls(control.controls ?? [], id, path);
	}
}

/**
 * 设置域注册表
 *
 * 各模块(Core / WebUI / 统计 ...)把自己的设置域注册进来, WebUI 设置页按域渲染,
 * 域之间互不感知。
 */
export class SettingsManager {
	private readonly domains = new Map<string, SettingsDomain<any>>();
	private closed = false;

	/** 注册一个设置域; 重复 id 直接拒绝, 避免静默覆盖 */
	register<T extends Record<string, unknown>>(
		id: string,
		options: SettingsDomainOptions<T>,
	): SettingsDomain<T> {
		if (this.closed) throw new Error("SettingsManager 已关闭, 不能再注册设置域");
		if (this.domains.has(id)) throw new Error(`设置域 ${id} 已注册`);
		assertPatchableSchema(options.schema, id);

		const domain = new SettingsDomain<T>(id, options);
		this.domains.set(id, domain);
		return domain;
	}

	/** 按 id 取域 */
	domain<T extends Record<string, unknown> = Record<string, unknown>>(id: string): SettingsDomain<T> | undefined {
		return this.domains.get(id) as SettingsDomain<T> | undefined;
	}

	/** 全部已注册的域 (按注册顺序) */
	list(): SettingsDomain<any>[] {
		return [...this.domains.values()];
	}

	/**
	 * 载入全部域
	 *
	 * 单个域的备份/重建失败不阻断其余域, 失败的域列在 `failures` 里由调用方决定
	 * 怎么处理。成功载入的域连同 `created` / `recovered` 一并返回, 供启动层
	 * 打印初始密码或提示值文件被重建。
	 */
	async loadAll(): Promise<SettingsLoadAllResult> {
		const loaded: SettingsLoadAllResult["loaded"] = [];
		const failures: SettingsLoadAllResult["failures"] = [];

		for (const [id, domain] of this.domains) {
			try {
				loaded.push({ id, result: await domain.load() });
			} catch (error) {
				failures.push({ id, error });
				logger.error(`设置域 ${id} 载入失败: ${error instanceof Error ? error.message : error}`);
			}
		}
		return { loaded, failures };
	}

	/** 注销一个域并释放; 返回是否确有该域 */
	unregister(id: string): boolean {
		const domain = this.domains.get(id);
		if (!domain) return false;
		domain.close();
		this.domains.delete(id);
		return true;
	}

	/** 释放所有域; 幂等 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const domain of this.domains.values()) domain.close();
		this.domains.clear();
	}
}
