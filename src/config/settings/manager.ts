import { readProp } from "../../utils/readProp";
import Logger from "../../utils/logger";
import { JsonFileStore, cloneValue, deepEqual } from "../store";
import { defaultsOf, entriesOf, toControls, writePath } from "./compile";
import { coercePatch, normalizeValues } from "./validate";
import type {
	SettingsDefinition,
	SettingsPatchResult,
	SettingsSnapshot,
} from "./types";

const logger = new Logger("Settings");

/** 逐字段变更回调 (与 ConfigManager.watch 同形) */
export type SettingsWatcher = (path: string, value: unknown, previousValue: unknown) => void;

export interface SettingsDomainOptions<T extends Record<string, unknown> = Record<string, unknown>> {
	/** 设置定义 (真相源) */
	definition: SettingsDefinition;
	/** 值文件路径 */
	file: string;
	/**
	 * 热应用钩子
	 *
	 * 校验与落盘成功后调用, 收到的是本次真正变化的字段 —— 且**已剔除 restart 字段**:
	 * 需要重启才生效的项在运行期没有意义, 不交给域去"假装应用"。
	 * 钩子抛错不回滚已落盘的值, 调用方会收到"已保存但热应用失败"的错误。
	 */
	apply?: (values: T, changed: string[]) => void | Promise<void>;
	/** 载入完成后调用 (把值同步给运行中的对象) */
	onLoad?: (values: T) => void | Promise<void>;
	/** 是否监听值文件的外部改动并自动重读, 默认 false */
	watchFile?: boolean;
	/** 注入存储 (测试用); 缺省新建一个绑定 file 的 JsonFileStore */
	store?: JsonFileStore<Record<string, unknown>>;
}

/**
 * 一个设置域: 定义 + 值文件 + 热应用钩子
 *
 * 值始终以完整值的形式持有 (缺失键补默认值、未知键丢弃), patch 只描述改了什么。
 * 对外读取统一经过脱敏, 敏感字段永远不出现在 `read()` / `patch()` 的返回值里。
 */
export class SettingsDomain<T extends Record<string, unknown> = Record<string, unknown>> {
	private readonly store: JsonFileStore<Record<string, unknown>>;
	private readonly watchers = new Set<SettingsWatcher>();

	/** 值文件外部改动的取消函数 */
	private unwatchStore: (() => void) | null = null;

	/** 静态语义标记, 构造时算好 */
	private readonly restartFields: string[];
	private readonly immutableFields: string[];

	constructor(readonly id: string, private readonly options: SettingsDomainOptions<T>) {
		const definition = options.definition;

		this.restartFields = entriesOf(definition)
			.filter(([, spec]) => spec.restart === true)
			.map(([path]) => path);
		this.immutableFields = entriesOf(definition)
			.filter(([, spec]) => spec.immutable === true)
			.map(([path]) => path);

		this.store = options.store ?? new JsonFileStore<Record<string, unknown>>(options.file, {
			defaults: () => defaultsOf(definition),
			normalize: (raw) => normalizeValues(definition, raw),
		});
	}

	get file(): string {
		return this.store.file;
	}

	/** 从文件载入; 文件缺失时按定义生成默认值 */
	async load(): Promise<T> {
		const values = await this.store.load();
		if (this.options.watchFile) this.attachFileWatch();
		await this.options.onLoad?.(values as T);
		return this.get();
	}

	/**
	 * 当前值 (含敏感字段明文), 返回深拷贝
	 *
	 * 这是**内部通道**, 供框架自身使用(如 WebUIServer 读监听端口与密码);
	 * 任何面向网络返回的地方都必须走 `read()` —— 那一个才是脱敏的。
	 */
	get(): T {
		return this.store.get() as T;
	}

	/** 对外快照: 控件投影 + 脱敏后的值 + 语义标记, 供 WebUI 直接渲染 */
	read(): SettingsSnapshot {
		const values = this.store.get();

		const setSecrets = entriesOf(this.options.definition)
			.filter(([path, spec]) => spec.secret === true && hasValue(readProp(values, path)))
			.map(([path]) => path);

		return {
			// ConfigRoot 形状: 前端 createConfigList 读 define.controls
			define: { controls: toControls(this.options.definition) },
			values: this.masked(values),
			setSecrets,
			restartFields: [...this.restartFields],
			immutableFields: [...this.immutableFields],
		};
	}

	/**
	 * 应用一份 patch
	 *
	 * 流程: 校验 → 合并 → 落盘 → 热应用 → 通知。
	 * 没有字段发生变化时不写盘、不调钩子, 直接返回空改动。
	 */
	async patch(input: unknown): Promise<SettingsPatchResult> {
		const before = this.store.get();
		const outcome = coercePatch(this.options.definition, before, input);

		if (outcome.changed.length === 0) {
			return { values: this.masked(outcome.values), changed: [], restartRequired: [] };
		}

		await this.store.commit(outcome.values);

		const hot = outcome.changed.filter((path) => !outcome.restartRequired.includes(path));
		if (hot.length > 0 && this.options.apply) {
			try {
				await this.options.apply(outcome.values as T, hot);
			} catch (e) {
				// 值已经落盘, 不回滚: 只把"热应用没成功"这件事明确报给调用方
				logger.error(`设置热应用失败 (domain=${this.id})`, e);
				// 错误对象常被序列化后上报或落日志: outcome 必须是脱敏的那一份
				throw new SettingsApplyError(
					`设置已保存, 但热应用失败: ${e instanceof Error ? e.message : String(e)}`,
					{
						values: this.masked(outcome.values),
						changed: outcome.changed,
						restartRequired: outcome.restartRequired,
					},
				);
			}
		}

		this.notify(before, outcome.values, outcome.changed);

		return {
			values: this.masked(outcome.values),
			changed: outcome.changed,
			restartRequired: outcome.restartRequired,
		};
	}

	/**
	 * 监听字段变更 (仅通过 patch 的改动触发)
	 *
	 * 回调收到的是**明文**(含敏感字段): 它是框架内部通道, handler 不得把它
	 * 写进日志、错误消息或任何会外流的结构。
	 */
	watch(handler: SettingsWatcher): () => void {
		this.watchers.add(handler);
		return () => { this.watchers.delete(handler); };
	}

	/** 停止文件监听并释放; 幂等 */
	close(): void {
		this.unwatchStore?.();
		this.unwatchStore = null;
		this.store.close();
		this.watchers.clear();
	}

	/* ---------- 内部 ---------- */

	/**
	 * 接上值文件的外部改动
	 *
	 * 外部改动只更新内存、同步给运行时并逐字段通知, **不**触发 apply:
	 * 热应用只对"经过校验的 patch"负责, 否则绕过校验的手改内容会静默进运行时。
	 */
	private attachFileWatch(): void {
		if (this.unwatchStore) return;

		this.store.startWatching();
		this.unwatchStore = this.store.watch((values, previous) => {
			Promise.resolve(this.options.onLoad?.(values as T)).catch((e) => {
				logger.error(`设置外部改动回调失败 (domain=${this.id})`, e);
			});
			this.notify(previous, values, this.changedPaths(previous, values));
		});
	}

	/** 逐字段比较出变化的路径 */
	private changedPaths(
		before: Record<string, unknown>,
		after: Record<string, unknown>,
	): string[] {
		const changed: string[] = [];
		for (const [path] of entriesOf(this.options.definition)) {
			if (!deepEqual(readProp(before, path), readProp(after, path))) changed.push(path);
		}
		return changed;
	}

	/** 按定义把所有敏感字段抹成空串 */
	private masked(values: Record<string, unknown>): Record<string, unknown> {
		const out = cloneValue(values);
		for (const [path, spec] of entriesOf(this.options.definition)) {
			if (spec.secret) writePath(out, path, "");
		}
		return out;
	}

	/** 逐个变更字段通知监听者; 单个监听器抛错不影响其余 */
	private notify(
		before: Record<string, unknown>,
		after: Record<string, unknown>,
		changed: string[],
	): void {
		if (this.watchers.size === 0) return;

		for (const path of changed) {
			const value = readProp(after, path);
			const previousValue = readProp(before, path);
			for (const handler of [...this.watchers]) {
				try {
					handler(path, value, previousValue);
				} catch (e) {
					logger.error(`设置变更回调出错 (domain=${this.id}, path=${path})`, e);
				}
			}
		}
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

/** 值是否算"已设置" (空串 / null / 空数组视为未设置) */
function hasValue(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	return true;
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
	 * 单个域的文件损坏不阻断其余域, 失败的域在返回值里列出, 由调用方决定
	 * 是记录日志还是让启动失败。
	 */
	async loadAll(): Promise<{ id: string; error: unknown }[]> {
		const failures: { id: string; error: unknown }[] = [];

		for (const [id, domain] of this.domains) {
			try {
				await domain.load();
			} catch (error) {
				failures.push({ id, error });
				logger.error(`设置域 ${id} 载入失败: ${error instanceof Error ? error.message : error}`);
			}
		}
		return failures;
	}

	/** 注销一个域并释放 (Bot 被删除时用) */
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
