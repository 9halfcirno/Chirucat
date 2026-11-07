import { DesiredStateStore, type DesiredStateStrategy } from "../config/desired-state-store";
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
 * Bot 状态的存储策略: 形状、旧格式兼容与等价判定都在这里, 与服务的
 * opt-out 黑名单策略显式分开。
 */
export const botStateStrategy: DesiredStateStrategy<BotState> = {
	defaults: () => copyState(DEFAULT_BOT_STATE),
	normalize,
	equals: isSameState,
};

/**
 * Bot 持久化启停状态管理器: 以 `<Bot目录>/state.json` 为后端。
 *
 * 文件结构 `{ enable: boolean, enabledPlugins: string[] }`, 表达**期望态**且是
 * opt-in 白名单: 只有登记过的插件才会被启用。读写/原子写/外部监听由基类
 * `DesiredStateStore` 承担, 本类只保留白名单的三种 setter 语义。
 *
 * 状态文件是每 Bot 一个: 删除 Bot 目录即清理干净, 不需要额外维护索引。
 */
export class BotStateManager extends DesiredStateStore<BotState> {
	constructor(file: string) {
		super(file, botStateStrategy);
	}

	/**
	 * 设置期望启用状态(持久化偏好)
	 * @param enable 是否期望该 Bot 运行
	 */
	async setEnable(enable: boolean): Promise<void> {
		const current = this.get();
		await this.commit({ enable, enabledPlugins: [...current.enabledPlugins] });
	}

	/**
	 * 设置单个插件的期望启用状态
	 * @param id 插件 id
	 * @param enabled 是否期望启用; false 时从列表中移除
	 */
	async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
		const current = this.get();
		const ids = new Set(current.enabledPlugins);
		enabled ? ids.add(id) : ids.delete(id);
		await this.commit({ enable: current.enable, enabledPlugins: [...ids] });
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

		const current = this.get();
		const kept = current.enabledPlugins.filter((id) => !drop.has(id));
		if (kept.length === current.enabledPlugins.length) return false;

		await this.commit({ enable: current.enable, enabledPlugins: kept });
		return true;
	}
}
