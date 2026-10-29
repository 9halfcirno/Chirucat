interface MapEntry<V> {
	value: V;
	expireTime: number;
}

export class TTLMap<K = any, V = any> {
	private map: Map<K, MapEntry<V>> = new Map();
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly cleanupInterval: number;
	private readonly maxCheckPerCycle: number;

	/**
	 * @param cleanupInterval 全局清理轮询间隔（毫秒），默认 5000ms
	 * @param maxCheckPerCycle 每轮轮询最多扫描检查的键数，默认 100 条
	 */
	constructor(cleanupInterval: number = 5000, maxCheckPerCycle: number = 100) {
		this.cleanupInterval = cleanupInterval;
		this.maxCheckPerCycle = maxCheckPerCycle;

		this.startCleanupTimer();
	}

	/**
	 * 写入键值对
	 * @param key 键
	 * @param value 值
	 * @param ttl 过期时长（毫秒）
	 */
	public set(key: K, value: V, ttl: number): void {
		if (ttl <= 0) return;
		const expireTime = Date.now() + ttl;
		this.map.set(key, { value, expireTime });
	}

	/**
	 * 读取 Key（含惰性清理）
	 */
	public get(key: K): V | undefined {
		const entry = this.map.get(key);
		if (!entry) return undefined;

		// 读取时已过期，立即移除喵
		if (Date.now() > entry.expireTime) {
			this.map.delete(key);
			return undefined;
		}

		return entry.value;
	}

	/**
	 * 判断 Key 是否存在且未过期
	 */
	public has(key: K): boolean {
		return this.get(key) !== undefined;
	}

	/**
	 * 删除指定 Key
	 */
	public delete(key: K): boolean {
		return this.map.delete(key);
	}

	/**
	 * 清空所有键值
	 */
	public clear(): void {
		this.map.clear();
	}

	/**
	 * 获取当前 Map 尺寸（注意：可能包含未被扫描到的已过期键）
	 */
	public get size(): number {
		return this.map.size;
	}

	/**
	 * 销毁实例，清理后台定时器
	 */
	public destroy(): void {
		this.stopCleanupTimer();
		this.map.clear();
	}

	/**
	 * 启动后台清理定时器
	 */
	private startCleanupTimer(): void {
		this.timer = setInterval(() => this.cleanupExpiredKeys(), this.cleanupInterval);

		// 兼容 Node.js 进程优雅退出喵
		if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
			(this.timer as { unref: () => void }).unref();
		}
	}

	/**
	 * 停止后台清理定时器
	 */
	private stopCleanupTimer(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * 内部方法：分批扫描并清理过期键喵 (•̀ᴗ•́)و ̑̑
	 */
	private cleanupExpiredKeys(): void {
		if (this.map.size === 0) return;

		const now = Date.now();
		let checkedCount = 0;

		for (const [key, entry] of this.map.entries()) {
			if (now > entry.expireTime) {
				this.map.delete(key);
			}

			checkedCount++;
			if (checkedCount >= this.maxCheckPerCycle) break;
		}
	}
  }