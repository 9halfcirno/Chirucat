import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import json5 from "json5";
import { atomicWriteJson } from "../utils/writeFile";
import { dirCheck } from "../utils/dir-check";
import Logger from "../utils/logger";

const logger = new Logger("JsonFileStore");

/* ---------- 值工具 (配置值只含原始类型 / 数组 / 普通对象) ---------- */

/** 是否为普通对象 (排除 null 与数组) */
export function isPlainObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 深拷贝一份 JSON 值 */
export function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
		return out as T;
	}
	return value;
}

/**
 * 深比较两份 JSON 值 —— 全项目唯一一份实现(设置域 / 期望态 / ConfigManager /
 * 插件宿主共用)。
 *
 * 输入域只有原始类型、数组与普通对象: 配置值来自 json5/JSON 解析, 插件清单亦然,
 * 不会出现 NaN / Date / Map / 循环引用, 因此不为它们做特判。
 * 三条刻意的语义: 数组顺序敏感; 数组与对象不相等; **键名也要对得上**
 * (只看键数会把 `{x:undefined}` 与 `{y:undefined}` 误判成相等)。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		return keys.every((key) =>
			Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
	}
	return false;
}

/* ---------- 写入原语 ---------- */

/**
 * 串行化执行器
 *
 * 把异步操作排成一条链: 链尾永远代表"此前所有操作已完成"。落盘用它保证
 * 一次只写一份, 后一次不会与上一次交错 (并发写交错会产生半截内容或丢改动)。
 */
export class SerialQueue {
	private tail: Promise<void> = Promise.resolve();

	/** 把一次操作排入链尾; 返回该次操作自身的期约 */
	run<R>(task: () => Promise<R>): Promise<R> {
		const result = this.tail.then(task);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}
}

/** 建目录并原子写入一份 JSON (写入过程中的崩溃不会留下半截文件) */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
	await dirCheck(path.dirname(file));
	await atomicWriteJson(file, value);
}

/* ---------- 选项 ---------- */

export interface JsonFileStoreOptions<T> {
	/** 文件缺失或损坏重建时用来生成初始内容的工厂 (返回值会被深拷贝后落盘, 除非 `createIfMissing` 为 false) */
	defaults: () => T;
	/** 把读到的原始 JSON 规范化成 T (丢弃未知键、补齐缺失键等); 缺省原样采用 */
	normalize?: (raw: unknown) => T;
	/**
	 * 读取/解析失败(文件缺失除外)时的行为
	 *
	 * - `throw`(默认): 向上抛出, 不静默覆盖用户内容 —— 用户数据文件适用
	 * - `fallback`: 记录警告并回落到默认值(不落盘), 后续写入覆盖损坏内容 —— 可重建的状态文件适用
	 * - `recreate`: 把损坏文件改名备份, 再按 `defaults()` 生成一份新的落盘 —— 设置值文件适用
	 */
	onError?: "throw" | "fallback" | "recreate";
	/**
	 * 文件缺失时是否顺手创建它 (默认创建)
	 *
	 * 设置类文件(configs/*.json)首次启动就该生成; 状态文件(state.json)按需创建 ——
	 * 缺失只表示"从未写过", 不该反过来给用户目录里添一份文件。
	 */
	createIfMissing?: boolean;
	/** 外部改动的读盘合并窗口(ms), 默认 100 */
	debounceMs?: number;
}

/** 一次读盘的结果 */
type ReadResult =
	| { kind: "value"; raw: unknown }
	| { kind: "missing" }
	| { kind: "invalid"; error: unknown };

/** 一次载入的结果: 除了值, 还说明这次对值文件做了什么 */
export interface LoadOutcome<T> {
	/** 载入后的值(深拷贝) */
	value: T;
	/** 值文件原本不存在, 本次按默认值生成 */
	created: boolean;
	/** 值文件损坏, 已备份原文件并按默认值重建 */
	recovered: boolean;
	/** 损坏原文件的备份路径(仅 recovered 时有值) */
	backupFile?: string;
}

/**
 * 一份 JSON 值文件的存储层: 原子写 + 串行化 + 可选外部改动监听。
 *
 * 它只认识"文件"和"值", 不认识控件定义与设置项语义 —— 因此
 * `ConfigManager`(schema 驱动) / `SettingsManager`(定义驱动) / 两个状态管理器
 * (Bot 与服务插件的期望态) 都共用同一套底座, 而不是各自再写一份读写与落盘。
 *
 * 三条契约:
 * 1. 写入一律经过本类: 原子写 + 串行化, 一次改动只落一次盘, 并发写不会交错
 * 2. `commit` 的期约在**落盘完成后**才 resolve (失败则 reject), 内存态不回滚
 * 3. `startWatching()` 后, 外部(手工编辑)改动会被重读并通知监听者;
 *    读盘期间内存若有未落盘的改动, 则保留内存态, 不被磁盘覆盖
 */
export class JsonFileStore<T> {
	/** 串行化执行链 */
	private readonly queue = new SerialQueue();

	/** 内存态 */
	private value: T;

	/** 内存状态版本号, 每次内存改动 +1 (用于识别"读盘期间又改了") */
	private revision = 0;

	private watcher: FSWatcher | null = null;
	private reloadTimer: NodeJS.Timeout | null = null;

	/** 外部改动监听器 (新值, 旧值) */
	private readonly listeners = new Set<(value: T, previous: T) => void>();

	private closed = false;

	constructor(readonly file: string, private readonly options: JsonFileStoreOptions<T>) {
		this.value = cloneValue(options.defaults());
	}

	/* ---------- 读取 ---------- */

	/** 当前内存值的一份深拷贝 */
	get(): T {
		return cloneValue(this.value);
	}

	/**
	 * 从文件载入值
	 *
	 * - 文件缺失: 用 `defaults()` 生成一份并落盘
	 * - 解析失败: 按 `onError` 抛出、回落默认值, 或备份后按默认值重建
	 * - 读盘期间内存已被改动(尚未落盘)时保留内存态, 不让磁盘内容把改动抹掉
	 *
	 * 需要知道"这次是否新建/重建了文件"的调用方改用 `loadOutcome()`。
	 *
	 * @param file 目标文件, 缺省用构造时传入的 file
	 */
	async load(file: string = this.file): Promise<T> {
		return (await this.loadOutcome(file)).value;
	}

	/**
	 * 从文件载入值, 并回报这次载入对值文件做了什么
	 *
	 * `created` / `recovered` 让启动层决定要不要打印初始密码、提示文件被重建,
	 * 而不必让每个域在自己的 `onCreate` 里塞日志 —— 域定义只描述数据。
	 *
	 * @param file 目标文件, 缺省用构造时传入的 file
	 */
	async loadOutcome(file: string = this.file): Promise<LoadOutcome<T>> {
		// 快照必须在入队**之前**取: 并发的写入会先改内存并推进 revision
		const expected = this.revision;

		return this.queue.run(async () => {
			const result = await this.read(file);
			const unchanged = (): LoadOutcome<T> => ({
				value: cloneValue(this.value), created: false, recovered: false,
			});

			// 读盘是异步的: 期间若有未落盘的改动, 以内存为准
			if (this.revision !== expected) return unchanged();

			if (result.kind === "missing") {
				// 状态文件按需创建: 缺失时只回落到默认值, 不主动落盘
				if (this.options.createIfMissing === false) {
					const fresh = cloneValue(this.options.defaults());
					// 内容无变化时不推进版本, 与下面读到现成文件时的判定一致
					if (deepEqual(this.value, fresh)) return unchanged();
					this.value = fresh;
					this.revision++;
					return unchanged();
				}

				const fresh = cloneValue(this.options.defaults());
				await writeJsonFile(file, fresh);

				// 落盘同样是个 await: 期间若有并发 commit, 内存里已是更新的值,
				// 不能再拿这份默认值覆盖它 —— 否则内存与磁盘分叉, 下一次 patch
				// 会以旧内存为基准, 把先前"已回报成功"的改动从磁盘上回滚。
				if (this.revision !== expected) return unchanged();

				this.value = fresh;
				this.revision++;
				return { value: cloneValue(this.value), created: true, recovered: false };
			}

			if (result.kind === "invalid") {
				if (this.options.onError === "recreate") {
					return this.recreate(file, expected, "值文件读取失败");
				}
				if (this.options.onError !== "fallback") throw result.error;
				logger.warn(`值文件读取失败, 回落默认值: ${file}`);
				this.value = cloneValue(this.options.defaults());
				this.revision++;
				return unchanged();
			}

			// 规范化也可能抛错(结构完全对不上定义): 与解析失败同等处理
			let fresh: T;
			try {
				fresh = this.options.normalize
					? this.options.normalize(result.raw)
					: (result.raw as T);
			} catch (e) {
				if (this.options.onError === "recreate") {
					return this.recreate(file, expected, "值文件规范化失败");
				}
				if (this.options.onError !== "fallback") throw e;
				logger.warn(`值文件规范化失败, 回落默认值: ${file}`);
				fresh = cloneValue(this.options.defaults());
			}

			// 内容无变化时不推进版本、不替换内存态, 便于外部监听的变更判定
			if (deepEqual(this.value, fresh)) return unchanged();

			this.value = fresh;
			this.revision++;
			return unchanged();
		});
	}

	/**
	 * 损坏文件的兜底: 原文件改名备份, 再按 defaults 生成一份新的
	 *
	 * 与 `ConfigManager.load()` 处理"文件缺失"一样, 默认值就是重建内容;
	 * 差别是这里先备份 —— 损坏的配置里可能有用户还来得及手工抢救的内容。
	 * 备份失败就抛, 绝不覆盖还留着原样的文件。
	 */
	private async recreate(file: string, expected: number, reason: string): Promise<LoadOutcome<T>> {
		const backupFile = `${file}.broken-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		await fs.rename(file, backupFile);

		const fresh = cloneValue(this.options.defaults());
		await writeJsonFile(file, fresh);
		logger.warn(`${reason}, 已备份为 ${backupFile} 并按默认值重建: ${file}`);

		// 落盘期间有并发写入时, 磁盘已被对方覆盖, 内存以它为准
		if (this.revision !== expected) {
			return { value: cloneValue(this.value), created: false, recovered: true, backupFile };
		}
		this.value = fresh;
		this.revision++;
		return { value: cloneValue(this.value), created: false, recovered: true, backupFile };
	}

	/* ---------- 写入 ---------- */

	/**
	 * 用一份新值替换内存态并落盘
	 *
	 * 内存先更新(同一 tick 内后续读取即可见), 再排队落盘; 落盘失败会 reject,
	 * 但写链本身保持可用, 内存态不回滚 —— 调用方拿到的是"没写成功"这个事实。
	 */
	async commit(value: T, file: string = this.file): Promise<void> {
		this.replace(value);
		const snapshot = cloneValue(this.value);

		await this.queue.run(() => writeJsonFile(file, snapshot));
	}

	/**
	 * 只替换内存态并推进版本, 不落盘
	 *
	 * 与 `write()` 对称: `write` 是"落盘当前内存", 本方法是"改内存、稍后统一保存"。
	 * 供 schema 热更新等需要「先改内存, 由调用方决定是否落盘」的适配层使用。
	 */
	replace(value: T): void {
		this.value = cloneValue(value);
		this.revision++;
	}

	/** 把当前内存值落盘(不推进版本); 供"内存已改、稍后统一保存"的调用方使用 */
	async write(file: string = this.file): Promise<void> {
		const snapshot = cloneValue(this.value);
		await this.queue.run(() => writeJsonFile(file, snapshot));
	}

	/* ---------- 外部改动监听 ---------- */

	/**
	 * 监听文件变化(含外部手改), 变更后重读并通知监听者
	 *
	 * 监听父目录而非文件本身: 原子写以 rename 替换文件, 直接监听文件在
	 * Windows 上会随替换失效。幂等。
	 */
	startWatching(): void {
		if (this.watcher || this.closed) return;

		const dir = path.dirname(this.file);
		const base = path.basename(this.file);

		try {
			this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
				// filename 在部分平台/场景下为 null, 此时宁可多读一次
				if (filename && filename !== base) return;
				this.scheduleReload();
			});
			this.watcher.on("error", (e) => logger.warn(`值文件监听出错: ${this.file} (${e})`));
		} catch (e) {
			// 监听失败只降级为"不响应外部改动", 不影响程序化读写
			logger.warn(`无法监听值文件, 外部修改不会自动生效: ${this.file} (${e})`);
		}
	}

	/** 注册外部改动监听(仅外部改动触发, 本类自身的写入不触发) */
	watch(handler: (value: T, previous: T) => void): () => void {
		this.listeners.add(handler);
		return () => { this.listeners.delete(handler); };
	}

	/** 停止监听并释放; 幂等 */
	close(): void {
		if (this.closed) return;
		this.closed = true;

		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
			this.reloadTimer = null;
		}
		this.watcher?.close();
		this.watcher = null;
		this.listeners.clear();
	}

	/* ---------- 内部 ---------- */

	/** 读取并解析文件, 区分"缺文件"与"解析失败"两种失败 */
	private async read(file: string): Promise<ReadResult> {
		let text: string;
		try {
			text = await fs.readFile(file, "utf-8");
		} catch (e) {
			// 文件不存在是正常情形(首次运行), 由调用方按默认值生成
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
			return { kind: "invalid", error: e };
		}

		try {
			return { kind: "value", raw: json5.parse(text) };
		} catch (e) {
			return { kind: "invalid", error: e };
		}
	}

	/** 合并窗口内的一次重读 */
	private scheduleReload(): void {
		if (this.closed) return;

		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = null;
			void this.notifyIfChanged();
		}, this.options.debounceMs ?? 100);
		// 待处理的重读不应阻止进程退出
		this.reloadTimer.unref?.();
	}

	/** 重读文件, 内容确有变化时才通知监听者 */
	private async notifyIfChanged(): Promise<void> {
		if (this.closed) return;

		const before = cloneValue(this.value);
		try {
			await this.load();
		} catch (e) {
			logger.error(`重读值文件失败: ${this.file}`, e);
			return;
		}

		if (deepEqual(before, this.value)) return;

		const snapshot = cloneValue(this.value);
		for (const listener of [...this.listeners]) {
			try {
				listener(snapshot, before);
			} catch (e) {
				// 单个监听器出错不影响其余监听器
				logger.error(`值文件变更回调出错: ${this.file}`, e);
			}
		}
	}
}
