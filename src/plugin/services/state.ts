import { DesiredStateStore, type DesiredStateStrategy } from "../../config/desired-state-store";

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
 * 服务状态的存储策略: 黑名单形状与等价判定都在这里, 与 Bot 的 opt-in
 * 白名单策略显式分开。
 */
export const serviceStateStrategy: DesiredStateStrategy<ServiceState> = {
	defaults: () => copyState(DEFAULT_SERVICE_STATE),
	normalize,
	equals: isSameState,
};

/**
 * 服务插件持久化启停状态管理器: 以 `configs/services/state.json` 为后端。
 *
 * 文件结构 `{ disabledServices: string[] }`, 表达**期望态**且是 opt-out 黑名单。
 * 读写/原子写/外部监听由基类 `DesiredStateStore` 承担, 本类只保留黑名单
 * 的查询、求解与批量 setter 语义(含依赖连带)。
 *
 * 状态文件是全局唯一的一份(服务插件不归属任何 Bot), 路径可在构造时注入,
 * 便于测试与嵌入式场景把它指到临时目录。
 */
export class ServiceStateManager extends DesiredStateStore<ServiceState> {
	constructor(file: string) {
		super(file, serviceStateStrategy);
	}

	/** 某个服务是否被显式停用 */
	isDisabled(id: string): boolean {
		return this.get().disabledServices.includes(id);
	}

	/**
	 * 从一份候选 id 里算出期望启用的那些(去掉停用名单, 保持传入顺序)
	 * @param all 候选服务插件 id(通常是注册表的全部键)
	 */
	resolve(all: readonly string[]): string[] {
		const disabled = new Set(this.get().disabledServices);
		return all.filter((id) => !disabled.has(id));
	}

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
		const current = this.get();
		const next = new Set(current.disabledServices);
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
}
