import { JsonFileStore } from "./store";

/**
 * 一份「期望态」状态的存储策略
 *
 * Bot 的 state.json 是 opt-in 白名单, 服务的 state.json 是 opt-out 黑名单,
 * 形状与名单语义都不同; 但读写、串行化、原子写、外部监听这套机制完全一样。
 * 差异集中在这里, 由各自的 StateManager 显式传入 —— 不在基类里用布尔开关
 * 切分支, 免得新增第三种状态时把两套语义揉成一团。
 */
export interface DesiredStateStrategy<T> {
	/** 文件缺失/损坏时使用的默认状态; 每次调用应返回可独立修改的新对象 */
	defaults: () => T;
	/** 把原始 JSON 规范化成 T: 丢弃未知键、去重、兼容旧格式 */
	normalize: (raw: unknown) => T;
	/** 两份状态是否等价(名单顺序敏感, 不重排) */
	equals: (a: T, b: T) => boolean;
}

/**
 * 期望态状态存储基类: `JsonFileStore` 之外只加一层「形状策略 + 变更判定」
 *
 * 只表达**期望变成什么样**, 不记录运行态: 运行态由宿主(Bot / ServiceHost)
 * 在内存里维护, 永不回写状态文件, 否则「收敛运行态」会反过来污染用户偏好。
 *
 * 三类共通契约(两套 StateManager 都遵循, 所以固定在基类里):
 * 1. 写入一律经 `commit` —— 原子写 + 串行化, 一次改动只落一次盘;
 *    setter 返回的期约在**落盘完成后**才 resolve
 * 2. 状态文件按需创建: 缺失只表示「从未写过」, 不反过来给用户目录添文件
 * 3. `startWatching()` 后外部(手工编辑)改动会重读并通知, 由宿主收敛运行态;
 *    本类自身的写入不触发通知
 *
 * 子类只保留各自的 setter 语义(白名单增删 / 黑名单增删与依赖连带)。
 */
export class DesiredStateStore<T> {
	private readonly store: JsonFileStore<T>;
	private readonly strategy: DesiredStateStrategy<T>;

	constructor(readonly file: string, strategy: DesiredStateStrategy<T>) {
		this.strategy = strategy;
		this.store = new JsonFileStore<T>(file, {
			defaults: strategy.defaults,
			normalize: strategy.normalize,
			onError: "fallback",
			createIfMissing: false,
		});
	}

	/** 当前状态的一份副本: 外部持有它不会被后续变更影响 */
	get(): T {
		return this.store.get();
	}

	/**
	 * 从文件重新读取并替换内存态
	 * @returns 内容是否发生了变化
	 */
	async load(): Promise<boolean> {
		const before = this.get();
		await this.store.load();
		return !this.strategy.equals(before, this.get());
	}

	/** 用一份完整期望态覆盖(整体替换, 名单顺序以传入为准) */
	async setState(next: T): Promise<void> {
		await this.commit(this.strategy.normalize(next));
	}

	/** 监听状态文件的外部改动; 本类自身的写入不触发 */
	startWatching(): void {
		this.store.startWatching();
	}

	/** 注册状态变更监听(仅外部改动触发); 返回取消监听 */
	watch(listener: (state: T) => void): () => void {
		return this.store.watch((state) => listener(state));
	}

	/** 停止监听并释放; 幂等 */
	close(): void {
		this.store.close();
	}

	/** 供子类的 setter 落盘: 结构已由 setter 自己构造好, 不再二次规范化 */
	protected async commit(next: T): Promise<void> {
		await this.store.commit(next);
	}
}
