import fs from "fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "path";
import json5 from "json5";
import { atomicWriteJson } from "../../utils/writeFile";
import Logger from "../../utils/logger";

const logger = new Logger("Service State");

/**
 * 服务插件的持久化状态(期望态)
 *
 * 语义是"默认启用, 只记录停用"(opt-out), 与 Bot 的 state.json(白名单, opt-in)
 * 不同 —— 这是有意的: 服务插件是框架级基础设施, 新装一个服务插件就该直接可用,
 * 不需要用户先去白名单里登记一次。于是:
 *
 * - 文件不存在、或名单为空 → 全部服务插件期望启用, 与引入持久化之前的行为一致
 * - 只有被显式停用过的服务才会出现在 `disabledServices` 里
 *
 * 只表达"期望变成什么样", 不记录运行态: 服务插件实际的 status 由 ServiceHost
 * 在内存中维护, 永不回写本文件, 否则"收敛运行态"会反过来污染用户偏好。
 */
export type ServiceState = {
	/** 显式停用的服务插件 id 列表 */
	disabledServices: string[];
};

/** 状态文件缺失/损坏时使用的默认状态: 不显式停用任何服务 */
export const DEFAULT_SERVICE_STATE: ServiceState = { disabledServices: [] };

/**
 * 外部改动合并窗口(ms)
 *
 * 与 BotStateManager 同因: 编辑器保存一次常常触发多个事件, 且原子写以 rename
 * 替换文件也会连续触发, 攒一小段时间再读盘, 避免一次保存读出多个中间态。
 */
const RELOAD_DEBOUNCE_MS = 100;

/** 状态变更监听器 */
export type ServiceStateListener = (state: ServiceState) => void;

/** 一份状态的副本 */
function copyState(state: ServiceState): ServiceState {
	return { disabledServices: [...state.disabledServices] };
}

/** 两份状态是否等价(顺序敏感: 只比较内容, 不重排) */
function isSameState(a: ServiceState, b: ServiceState): boolean {
	return a.disabledServices.length === b.disabledServices.length
		&& a.disabledServices.every((id, i) => id === b.disabledServices[i]);
}

/** 规范化一份状态: 只保留已知字段, 丢弃空值与重复项 */
function normalize(raw: unknown): ServiceState {
	const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const ids = new Set<string>();

	if (Array.isArray(src.disabledServices)) {
		for (const id of src.disabledServices) {
			if (typeof id === "string" && id) ids.add(id);
		}
	}

	return { disabledServices: [...ids] };
}

/**
 * 服务插件持久化启停状态管理器: 以 `configs/services/state.json` 为后端。
 *
 * 文件结构 `{ disabledServices: string[] }`, 表达**期望态**:
 * - `disabledServices`: 期望停用的服务插件 id 列表
 *
 * 三条契约(与 BotStateManager 保持一致):
 * 1. 写入一律经过本类 —— 原子写 + 串行化, 一次改动只落一次盘
 * 2. 所有 setter 返回的期约在**落盘完成后**才 resolve (失败则 reject)
 * 3. 文件可被外部修改, `startWatching()` 后自动重读并通知监听者,
 *    由调用方决定如何把运行态收敛过来
 *
 * 状态文件是全局唯一的一份(服务插件不归属任何 Bot), 路径可在构造时注入,
 * 便于测试与嵌入式场景把它指到临时目录。
 */
export class ServiceStateManager {
	/** 当前内存态(期望态) */
	private state: ServiceState;

	/** 串行化写链: 链尾表示"此前所有操作已完成" */
	private writing: Promise<void> = Promise.resolve();

	/** 内存状态版本号, 每次内存改动 +1 (用于识别"读盘期间又改了") */
	private revision = 0;

	/** 文件监听器 */
	private watcher: FSWatcher | null = null;

	/** 重读合并定时器 */
	private reloadTimer: NodeJS.Timeout | null = null;

	/** 变更监听器 */
	private listeners = new Set<ServiceStateListener>();

	/** 已释放标记 */
	private closed = false;

	constructor(readonly file: string) {
		this.state = copyState(DEFAULT_SERVICE_STATE);
	}

	/** 当前状态的一份副本: 外部持有它不会被后续变更影响 */
	get(): ServiceState {
		return copyState(this.state);
	}

	/** 某个服务是否被显式停用 */
	isDisabled(id: string): boolean {
		return this.state.disabledServices.includes(id);
	}

	/**
	 * 从一份候选 id 里算出期望启用的那些(去掉停用名单, 保持传入顺序)
	 * @param all 候选服务插件 id(通常是注册表的全部键)
	 */
	resolve(all: readonly string[]): string[] {
		const disabled = new Set(this.state.disabledServices);
		return all.filter((id) => !disabled.has(id));
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
		const expected = this.revision;

		return this.enqueue(async () => {
			const fresh = await this.read();

			if (this.revision !== expected) return false;
			if (isSameState(this.state, fresh)) return false;

			this.state = fresh;
			return true;
		});
	}

	/** 把一次操作排入串行链; 链尾永远代表"此前所有操作已完成" */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.writing.then(task);
		this.writing = run.then(() => undefined, () => undefined);
		return run;
	}

	/* ---------- 写入 ---------- */

	/**
	 * 设置单个服务的期望启用状态
	 * @param id 服务插件 id
	 * @param enabled 是否期望启用; false 时加入停用名单, true 时移出
	 */
	async setEnabled(id: string, enabled: boolean): Promise<void> {
		await this.setEnabledMany([id], enabled);
	}

	/**
	 * 批量设置一组服务的期望启用状态
	 *
	 * 用于依赖连带: 停用一个服务时把被它牵连的依赖者一并记进名单, 启用时把
	 * 依赖一并移出 —— 名单与运行态保持同一口径, 下次启动才不会自相矛盾。
	 * 名单没有实际变化时不写盘。
	 * @param ids 服务插件 id
	 * @param enabled 是否期望启用
	 * @returns 是否真的发生了改动
	 */
	async setEnabledMany(ids: readonly string[], enabled: boolean): Promise<boolean> {
		const next = new Set(this.state.disabledServices);
		let changed = false;

		for (const id of ids) {
			if (!id) continue;
			const had = next.has(id);
			if (enabled) {
				if (had) { next.delete(id); changed = true; }
			} else if (!had) {
				next.add(id); changed = true;
			}
		}

		if (!changed) return false;

		await this.commit({ disabledServices: [...next] });
		return true;
	}

	/**
	 * 用一份完整期望态覆盖(名单整体替换, 顺序以传入为准)
	 * @param next 期望状态
	 */
	async setState(next: ServiceState): Promise<void> {
		await this.commit(next);
	}

	/**
	 * 提交一份状态: 先更新内存(同一 tick 内后续读取即可见), 再排队落盘
	 *
	 * 落盘失败会 reject 给调用方, 但写链本身保持可用(下一次写入照常执行)。
	 * 内存态不回滚 —— 调用方拿到的是"没写成功"这个事实, 而不是一个被悄悄改回去的状态。
	 */
	private async commit(next: ServiceState): Promise<void> {
		this.state = normalize(next);
		this.revision++;
		const snapshot = copyState(this.state);

		await this.enqueue(() => this.write(snapshot));
	}

	/** 原子写入快照; 失败向上抛(调用方决定是否展示/重试) */
	private async write(snapshot: ServiceState): Promise<void> {
		// 记下写入时的版本, 便于排查内存与磁盘不一致
		const revision = this.revision;
		await atomicWriteJson(this.file, snapshot, { mkdirp: true });
		logger.debug(`服务插件状态已保存 (rev ${revision}): ${this.file}`);
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
			// 监听失败只降级为"不响应外部改动", 不影响程序化读写
			logger.warn(`无法监听状态文件, 外部修改将不会自动生效: ${this.file} (${e})`);
		}
	}

	/**
	 * 注册状态变更监听(仅外部改动触发, 本类自身的写入不触发)
	 * @param listener 变更回调
	 * @returns 取消监听
	 */
	watch(listener: ServiceStateListener): () => void {
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
	 * 读取状态文件; 文件缺失(从未写过)或内容损坏时回退默认状态
	 *
	 * 读取失败不抛错: 状态文件损坏不应该让服务插件无法加载, 后续写入会覆盖成合法内容。
	 */
	private async read(): Promise<ServiceState> {
		let text: string;
		try {
			text = await fs.readFile(this.file, "utf-8");
		} catch (e) {
			// 文件不存在是正常情形(从未停用过任何服务), 不打扰日志
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn(`读取状态文件失败, 使用默认状态: ${this.file}`);
			}
			return copyState(DEFAULT_SERVICE_STATE);
		}

		try {
			return normalize(json5.parse(text));
		} catch {
			logger.warn(`状态文件解析失败, 使用默认状态: ${this.file}`);
			return copyState(DEFAULT_SERVICE_STATE);
		}
	}
}
