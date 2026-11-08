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
		await this.setEnabledMany([id], enabled);
	}

	/**
	 * 批量设置一组插件的期望启用状态
	 *
	 * 用于依赖连带: 停用被依赖的插件时, 被它牵连卸载的依赖者要一并移出白名单,
	 * 否则重启后仍在名单里的依赖者会沿加载递归把整棵依赖树重新拉起。名单没有
	 * 实际变化时不写盘。
	 * @param ids 插件 id
	 * @param enabled 是否期望启用; false 时从列表中移除
	 * @returns 是否真的发生了改动
	 */
	async setEnabledMany(ids: readonly string[], enabled: boolean): Promise<boolean> {
		const current = this.get();
		const wanted = new Set(current.enabledPlugins);
		let changed = false;

		for (const id of ids) {
			if (!id) continue;
			const had = wanted.has(id);
			if (enabled) {
				if (!had) { wanted.add(id); changed = true; }
			} else if (had) {
				wanted.delete(id); changed = true;
			}
		}

		if (!changed) return false;

		await this.commit({ enable: current.enable, enabledPlugins: [...wanted] });
		return true;
	}
}
