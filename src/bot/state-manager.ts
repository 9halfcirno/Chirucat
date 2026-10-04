import { JsonFileStore } from "../config/store";
import type { BotState } from "./types";

/** 状态文件缺失/损坏时使用的默认状态 */
export const DEFAULT_BOT_STATE: BotState = { enable: false, enabledPlugins: [] };

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
 * 读写、串行化、原子写与外部改动监听全部复用 `JsonFileStore` —— 本类只描述
 * Bot 状态的形状与各 setter 语义。三条契约见 `JsonFileStore`:
 * 1. 写入一律经过本类 —— 原子写 + 串行化, 一次改动只落一次盘
 * 2. 所有 setter 返回的期约在**落盘完成后**才 resolve (失败则 reject)
 * 3. 文件可被外部修改, `startWatching()` 后自动重读并通知监听者,
 *    由调用方决定如何把运行态收敛过来
 *
 * 状态文件是每 Bot 一个: 删除 Bot 目录即清理干净, 不需要额外维护索引。
 */
export class BotStateManager {
	private readonly store: JsonFileStore<BotState>;

	constructor(readonly file: string) {
		this.store = new JsonFileStore<BotState>(file, {
			defaults: () => copyState(DEFAULT_BOT_STATE),
			normalize,
			onError: "fallback",
			// 缺失只表示"从未写过状态", 不反过来给 Bot 目录添文件
			createIfMissing: false,
		});
	}

	/** 当前状态的一份副本: 外部持有它不会被后续变更影响 */
	get(): BotState {
		return this.store.get();
	}

	/**
	 * 从文件重新读取并替换内存态
	 *
	 * @returns 内容是否发生了变化
	 */
	async load(): Promise<boolean> {
		const before = this.store.get();
		await this.store.load();
		return !isSameState(before, this.store.get());
	}

	/**
	 * 设置期望启用状态(持久化偏好)
	 * @param enable 是否期望该 Bot 运行
	 */
	async setEnable(enable: boolean): Promise<void> {
		const current = this.store.get();
		await this.store.commit({ enable, enabledPlugins: [...current.enabledPlugins] });
	}

	/**
	 * 设置单个插件的期望启用状态
	 * @param id 插件 id
	 * @param enabled 是否期望启用; false 时从列表中移除
	 */
	async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
		const current = this.store.get();
		const ids = new Set(current.enabledPlugins);
		enabled ? ids.add(id) : ids.delete(id);
		await this.store.commit({ enable: current.enable, enabledPlugins: [...ids] });
	}

	/**
	 * 批量移出期望启用列表(不在列表里的 id 忽略)
	 *
	 * 供"插件运行态收敛失败"后清理期望: 运行态给不出来的插件不留在文件里。
	 * 列表没有实际变化时不写盘。
	 * @param ids 要移除的插件 id
	 * @returns 是否真的发生了改动
	 */
	async disablePlugins(ids: readonly string[]): Promise<boolean> {
		const drop = new Set(ids);
		if (drop.size === 0) return false;

		const current = this.store.get();
		const kept = current.enabledPlugins.filter((id) => !drop.has(id));
		if (kept.length === current.enabledPlugins.length) return false;

		await this.store.commit({ enable: current.enable, enabledPlugins: kept });
		return true;
	}

	/**
	 * 用一份完整期望态覆盖(列表整体替换, 顺序以传入为准)
	 * @param next 期望状态
	 */
	async setState(next: BotState): Promise<void> {
		await this.store.commit(normalize(next));
	}

	/** 监听状态文件的外部改动; 本类自身的写入不触发 */
	startWatching(): void {
		this.store.startWatching();
	}

	/**
	 * 注册状态变更监听(仅外部改动触发, 本类自身的写入不触发)
	 * @param listener 变更回调
	 * @returns 取消监听
	 */
	watch(listener: BotStateListener): () => void {
		return this.store.watch((state) => listener(state));
	}

	/** 停止监听并释放; 幂等 */
	close(): void {
		this.store.close();
	}
}
