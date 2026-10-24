/**
 * 滑动窗口: 只数"谁派发了多少条", 不看内容
 *
 * 这是受理人机制的唯一观测面。刻意不保留消息内容、指纹、顺序 —— 平台之间同一条
 * 真实消息的渲染结果可以毫无共同点(卡片 vs 封面图、动画表情 vs 占位文本), 任何
 * 依赖内容的判定都会在真实数据上退化。速率差是聚合量: 单条丢包、单条晚到会被
 * 窗口摊平, 不会像逐条配对那样被一次错配污染。
 *
 * 两类计数分开:
 * - **探针**: 非 @ 的普通消息。只有它参与受理人转移的判定 —— @ 消息的到达与否
 *   受"用户想找谁"影响, 不是稳定的流量信号。
 * - **@**: 单独计数, 只供 @ 快速通道使用。
 *
 * 时间由调用方传入(不读 `Date.now()`), 因此可以被自检脚本用构造时间戳直接驱动,
 * 测试不需要真的等待。
 */
export class SlidingWindow {
	/** adapter -> 非 @ 消息的到达时刻(升序) */
	#probes = new Map<string, number[]>();
	/** adapter -> @ 本 Bot 的消息到达时刻(升序) */
	#mentions = new Map<string, number[]>();

	/**
	 * 记录一次派发
	 * @param adapter 适配器 id
	 * @param at 到达时刻(ms)
	 * @param mentionedSelf 是否 @ 了本 Bot
	 *
	 * 两类计数**互斥**: @ 消息只进 @ 计数, 不进探针计数 —— 探针是“稳定流量信号”,
	 * @ 的到达与否取决于“用户想找谁”, 拿它当流量会误判。平台未提供( `null` )的消息
	 * 无法判断, 保守地当作普通流量计入探针。
	 */
	record(adapter: string, at: number, mentionedSelf: boolean | null): void {
		if (mentionedSelf === true) {
			const mentions = this.#mentions.get(adapter);
			if (mentions) mentions.push(at);
			else this.#mentions.set(adapter, [at]);
			return;
		}

		const probes = this.#probes.get(adapter);
		if (probes) probes.push(at);
		else this.#probes.set(adapter, [at]);
	}

	/**
	 * 取窗口内每个适配器的非 @ 派发量
	 * @param at 当前时刻
	 * @param windowMs 窗口长度
	 */
	counts(at: number, windowMs: number): Record<string, number> {
		return this.#snapshot(this.#probes, at, windowMs);
	}

	/** 取窗口内每个适配器的 @ 派发量 */
	mentions(at: number, windowMs: number): Record<string, number> {
		return this.#snapshot(this.#mentions, at, windowMs);
	}

	/**
	 * 取每个适配器最近一次非 @ 派发的时刻
	 *
	 * @ 快速通道要判断"受理人是不是彻底没动静了", 用最近时刻比用计数更直接:
	 * 计数为 0 也可能是窗口还没攒够, 而"从未派发"与"很久没派发"是同一件事。
	 */
	lastProbeAt(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [adapter, list] of this.#probes) {
			const last = list[list.length - 1];
			if (last !== undefined) out[adapter] = last;
		}
		return out;
	}

	/** 清空全部计数 */
	clear(): void {
		this.#probes.clear();
		this.#mentions.clear();
	}

	/**
	 * 丢弃窗口外的时刻
	 * @returns 窗口内是否还有数据; `false` 说明这个窗口可以整个丢掉
	 */
	prune(at: number, windowMs: number): boolean {
		const probes = this.#snapshot(this.#probes, at, windowMs);
		const mentions = this.#snapshot(this.#mentions, at, windowMs);

		// 两个映射里已经没有残留的键时, 窗口本身就该被回收
		return Object.keys(probes).length > 0 || Object.keys(mentions).length > 0;
	}

	/** 丢弃窗口外的时刻, 返回窗口内的计数 */
	#snapshot(
		source: Map<string, number[]>,
		at: number,
		windowMs: number,
	): Record<string, number> {
		const cutoff = at - windowMs;
		const out: Record<string, number> = {};

		for (const [adapter, list] of source) {
			// 时刻升序, 从头部丢弃即可; 顺手把数组裁短, 避免长时间运行时无限增长
			let drop = 0;
			while (drop < list.length && list[drop]! < cutoff) drop++;
			if (drop > 0) list.splice(0, drop);

			if (list.length > 0) out[adapter] = list.length;
		}

		return out;
	}
}
