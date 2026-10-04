import { JsonFileStore } from "../../config/store";

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
 * 服务插件持久化启停状态管理器: 以 `configs/services/state.json` 为后端。
 *
 * 文件结构 `{ disabledServices: string[] }`, 表达**期望态**:
 * - `disabledServices`: 期望停用的服务插件 id 列表
 *
 * 读写、串行化、原子写与外部改动监听全部复用 `JsonFileStore` —— 本类只描述
 * 服务状态的形状与各 setter 语义(与 `BotStateManager` 同构, 只是名单语义相反)。
 * 契约见 `JsonFileStore`:
 * 1. 写入一律经过本类 —— 原子写 + 串行化, 一次改动只落一次盘
 * 2. 所有 setter 返回的期约在**落盘完成后**才 resolve (失败则 reject)
 * 3. 文件可被外部修改, `startWatching()` 后自动重读并通知监听者,
 *    由调用方决定如何把运行态收敛过来
 *
 * 状态文件是全局唯一的一份(服务插件不归属任何 Bot), 路径可在构造时注入,
 * 便于测试与嵌入式场景把它指到临时目录。
 */
export class ServiceStateManager {
	private readonly store: JsonFileStore<ServiceState>;

	constructor(readonly file: string) {
		this.store = new JsonFileStore<ServiceState>(file, {
			defaults: () => copyState(DEFAULT_SERVICE_STATE),
			normalize,
			onError: "fallback",
			// 缺失只表示"从未停用过任何服务", 不反过来创建文件
			createIfMissing: false,
		});
	}

	/** 当前状态的一份副本: 外部持有它不会被后续变更影响 */
	get(): ServiceState {
		return this.store.get();
	}

	/** 某个服务是否被显式停用 */
	isDisabled(id: string): boolean {
		return this.store.get().disabledServices.includes(id);
	}

	/**
	 * 从一份候选 id 里算出期望启用的那些(去掉停用名单, 保持传入顺序)
	 * @param all 候选服务插件 id(通常是注册表的全部键)
	 */
	resolve(all: readonly string[]): string[] {
		const disabled = new Set(this.store.get().disabledServices);
		return all.filter((id) => !disabled.has(id));
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
		const current = this.store.get();
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

		await this.store.commit({ disabledServices: [...next] });
		return true;
	}

	/**
	 * 用一份完整期望态覆盖(名单整体替换, 顺序以传入为准)
	 * @param next 期望状态
	 */
	async setState(next: ServiceState): Promise<void> {
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
	watch(listener: ServiceStateListener): () => void {
		return this.store.watch((state) => listener(state));
	}

	/** 停止监听并释放; 幂等 */
	close(): void {
		this.store.close();
	}
}
