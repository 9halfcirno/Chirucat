import fs from "fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "path";
import json5 from "json5";
import { atomicWriteJson } from "../utils/writeFile";
import Logger from "../utils/logger";
import type { BotState } from "./types";

const logger = new Logger("Bot State");

/** 状态文件缺失/损坏时使用的默认状态 */
export const DEFAULT_BOT_STATE: BotState = { enable: false, enabledPlugins: [] };

/**
 * 外部改动合并窗口(ms)
 *
 * 编辑器保存一次常常触发多个事件, 且原子写以 rename 替换文件也会连续触发,
 * 攒一小段时间再读盘, 避免一次保存读出多个中间态。
 */
const RELOAD_DEBOUNCE_MS = 100;

/** 状态变更监听器 */
export type BotStateListener = (state: BotState) => void;

/** 一份状态的副本 */
function copyState(state: BotState): BotState {
	return { enable: state.enable, enabledPlugins: [...state.enabledPlugins] };
}

/** 两份状态是否等价(顺序敏感: 只比较内容, 不重排) */
function isSameState(a: BotState, b: BotState): boolean {
	return a.enable === b.enable
		&& a.enabledPlugins.length === b.enabledPlugins.length
		&& a.enabledPlugins.every((id, i) => id === b.enabledPlugins[i]);
}

/**
 * 规范化一份状态: 只保留已知字段, 未识别的键丢弃
 *
 * 同时兼容旧格式 `plugins: { <插件id>: boolean }` —— 取值为 true 的键
 * 转成 enabledPlugins。旧格式写回时会被统一成新结构。
 */
function normalize(raw: unknown): BotState {
	const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const ids = new Set<string>();

	if (Array.isArray(src.enabledPlugins)) {
		for (const id of src.enabledPlugins) {
			if (typeof id === "string" && id) ids.add(id);
		}
	}

	const legacy = src.plugins;
	if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
		for (const [id, on] of Object.entries(legacy)) {
			if (on === true && id) ids.add(id);
		}
	}

	return { enable: src.enable === true, enabledPlugins: [...ids] };
}

/**
 * Bot 持久化启停状态管理器: 以 `<Bot目录>/state.json` 为后端。
 *
 * 文件结构 `{ enable: boolean, enabledPlugins: string[] }`, 表达**期望态**:
 * - `enable`: 是否期望该 Bot 运行
 * - `enabledPlugins`: 期望启用的插件 id 列表
 *
 * 三条契约:
 * 1. 写入一律经过本类 —— 原子写 + 串行化, 一次改动只落一次盘
 * 2. 所有 setter 返回的期约在**落盘完成后**才 resolve (失败则 reject)
 * 3. 文件可被外部修改, `startWatching()` 后自动重读并通知监听者,
 *    由调用方决定如何把运行态收敛过来
 *
 * 状态文件是每 Bot 一个: 删除 Bot 目录即清理干净, 不需要额外维护索引。
 */
export class BotStateManager {
	/** 当前内存态(期望态) */
	private state: BotState;

	/** 串行化写链: 链尾表示“此前所有操作已完成” */
	private writing: Promise<void> = Promise.resolve();

	/** 内存状态版本号, 每次内存改动 +1 (用于识别“读盘期间又改了”) */
	private revision = 0;

	/** 文件监听器 */
	private watcher: FSWatcher | null = null;

	/** 重读合并定时器 */
	private reloadTimer: NodeJS.Timeout | null = null;

	/** 变更监听器 */
	private listeners = new Set<BotStateListener>();

	/** 已释放标记 */
	private closed = false;

	constructor(readonly file: string) {
		this.state = copyState(DEFAULT_BOT_STATE);
	}

	/** 当前状态的一份副本: 外部持有它不会被后续变更影响 */
	get(): BotState {
		return copyState(this.state);
	}

	/* ---------- 读取 ---------- */

	/**
	 * 从文件重新读取并替换内存态
	 *
	 * 与写入共用同一条串行链, 并带版本校验: 读盘是异步的, 若期间又有改动落进
	 * 内存(它尚未落盘), 直接用磁盘内容覆盖会把那次改动默默抹掉。因此只在版本
	 * 未变时应用。被放弃的那次外部改动不会丢 —— 与它并发的写入会覆盖磁盘,
	 * 属于后写者胜; 写入自身也会触发新一轮重读。
	 * @returns 内容是否发生了变化
	 */
	async load(): Promise<boolean> {
		// 快照必须在入队**之前**取: 并发的写入会先改内存并推进 revision,
		// 若等到 task 被调度时才读, 拿到的已是推进后的版本号, 守卫会失效。
		// 也正因如此, 本方法要排在写链之后 —— 它只应看到此前已落盘的结果。
		const expected = this.revision;

		return this.enqueue(async () => {
			const fresh = await this.read();

			if (this.revision !== expected) return false;
			if (isSameState(this.state, fresh)) return false;

			this.state = fresh;
			return true;
		});
	}

	/** 把一次操作排入串行链; 链尾永远代表“此前所有操作已完成” */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.writing.then(task);
		this.writing = run.then(() => undefined, () => undefined);
		return run;
	}

	/* ---------- 写入 ---------- */

	/**
	 * 设置期望启用状态(持久化偏好)
	 * @param enable 是否期望该 Bot 运行
	 */
	async setEnable(enable: boolean): Promise<void> {
		await this.commit({ enable, enabledPlugins: [...this.state.enabledPlugins] });
	}

	/**
	 * 设置单个插件的期望启用状态
	 * @param id 插件 id
	 * @param enabled 是否期望启用; false 时从列表中移除
	 */
	async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
		const ids = new Set(this.state.enabledPlugins);
		enabled ? ids.add(id) : ids.delete(id);
		await this.commit({ enable: this.state.enable, enabledPlugins: [...ids] });
	}

	/**
	 * 用一份完整期望态覆盖(列表整体替换, 顺序以传入为准)
	 * @param next 期望状态
	 */
	async setState(next: BotState): Promise<void> {
		await this.commit(next);
	}

	/**
	 * 提交一份状态: 先更新内存(同一 tick 内后续读取即可见), 再排队落盘
	 *
	 * 落盘失败会 reject 给调用方, 但写链本身保持可用(下一次写入照常执行)。
	 * 内存态不回滚 —— 调用方拿到的是“没写成功”这个事实, 而不是一个被悄悄改回去的状态。
	 */
	private async commit(next: BotState): Promise<void> {
		this.state = normalize(next);
		this.revision++;
		const snapshot = copyState(this.state);

		await this.enqueue(() => this.write(snapshot));
	}

	/** 原子写入快照; 失败向上抛(调用方决定是否展示/重试) */
	private async write(snapshot: BotState): Promise<void> {
		// 记下写入时的版本, 便于排查内存与磁盘不一致
		const revision = this.revision;
		await atomicWriteJson(this.file, snapshot, { mkdirp: true });
		logger.debug(`状态已保存 (rev ${revision}): ${this.file}`);
	}

	/* ---------- 文件监听 ---------- */

	/**
	 * 监听状态文件的变化(含外部手改), 变更后重读并通知监听者
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
			this.watcher.on("error", (e) => logger.warn(`状态文件监听出错: ${this.file} (${e})`));
		} catch (e) {
			// 监听失败只降级为“不响应外部改动”, 不影响程序化读写
			logger.warn(`无法监听状态文件, 外部修改将不会自动生效: ${this.file} (${e})`);
		}
	}

	/**
	 * 注册状态变更监听(仅外部改动触发, 本类自身的写入不触发)
	 * @param listener 变更回调
	 * @returns 取消监听
	 */
	watch(listener: BotStateListener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** 合并窗口内的一次重读 */
	private scheduleReload(): void {
		if (this.closed) return;

		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = null;
			void this.notifyIfChanged();
		}, RELOAD_DEBOUNCE_MS);
		// 待处理的重读不应阻止进程退出
		this.reloadTimer.unref?.();
	}

	/** 重读文件, 内容确有变化时才通知监听者 */
	private async notifyIfChanged(): Promise<void> {
		if (this.closed) return;

		try {
			if (!await this.load()) return;
		} catch (e) {
			logger.error(`重读状态文件失败: ${this.file}`, e);
			return;
		}

		const snapshot = this.get();
		for (const listener of [...this.listeners]) {
			try {
				listener(snapshot);
			} catch (e) {
				// 单个监听器出错不影响其余监听器
				logger.error(`状态变更回调出错: ${this.file}`, e);
			}
		}
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

	/* ---------- 读盘 ---------- */

	/**
	 * 读取状态文件; 文件缺失(新 Bot 尚未写过)或内容损坏时回退默认状态
	 *
	 * 读取失败不抛错: 状态文件损坏不应该让 Bot 无法加载, 后续写入会覆盖成合法内容。
	 */
	private async read(): Promise<BotState> {
		let text: string;
		try {
			text = await fs.readFile(this.file, "utf-8");
		} catch (e) {
			// 文件不存在是正常情形(从未写过状态), 不打扰日志
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn(`读取状态文件失败, 使用默认状态: ${this.file}`);
			}
			return copyState(DEFAULT_BOT_STATE);
		}

		try {
			return normalize(json5.parse(text));
		} catch {
			logger.warn(`状态文件解析失败, 使用默认状态: ${this.file}`);
			return copyState(DEFAULT_BOT_STATE);
		}
	}
}
