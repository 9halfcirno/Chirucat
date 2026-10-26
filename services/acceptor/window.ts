/**
 * 滑动窗口: 只数“谁派发了多少条”, 不看内容
 *
 * 这是受理人机制的唯一观测面。刻意不保留消息内容、指纹、顺序 —— 平台之间同一条
 * 真实消息的渲染结果可以毫无共同点(卡片 vs 封面图、动画表情 vs 占位文本), 任何
 * 依赖内容的判定都会在真实数据上退化。速率差是聚合量: 单条丢包、单条晚到会被
 * 窗口摊平, 不会像逐条配对那样被一次错配污染。
 *
 * 两类计数分开:
 * - **探针**: 非 @ 的普通消息。只有它参与受理人转移的判定 —— @ 消息的到达与否
 *   受“用户想找谁”影响, 不是稳定的流量信号。
 * - **@**: 单独计数, 只供 @ 快速通道使用。
 *
 * 除了记录入站消息, 还有一种由**出站**产生的计数: {@link credit}。自己发出的消息会
 * 被同一群里的另一个适配器当成入站消息收到(平台不会把“自己发的”回音给它自己),
 * 于是另一端凭空多出一条探针。详见该方法上的说明。
 *
 * 时间由调用方传入(不读 `Date.now()`), 因此可以被自检脚本用构造时间戳直接驱动,
 * 测试不需要真的等待。
 */
export class SlidingWindow {
	/** adapter -> 非 @ 消息的到达时刻(升序) */
	#probes = new Map<string, number[]>();
	/** adapter -> @ 本 Bot 的消息到达时刻(升序) */
	#mentions = new Map<string, number[]>();
	/** adapter -> 最近一次非 @ 派发时刻; **不随窗口裁剪丢弃** */
	#lastAt = new Map<string, number>();

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

		// 计数会被窗口裁掉, 但“最近一次”要留住: 它既是 @ 快速通道的沉默判据,
		// 也是“这个会话里出现过哪些适配器”的唯一来源 —— 静默后仍要能手工切回去。
		const last = this.#lastAt.get(adapter);
		if (last === undefined || at > last) this.#lastAt.set(adapter, at);
	}

	/**
	 * 抵扣一次“自己发出去、被对方收到”的回声
	 *
	 * 背景: 两条适配器同时在群里时, 受理人发一条回复, 平台会把它投给**另一个**
	 * 适配器(自己发出的不会回音给自己)。那条消息在 B 侧是一条普通的非 @ 消息,
	 * 于是 B 的探针计数 +1。两端差值恰好等于“bot 通过受理人发出的消息数”,
	 * 越活跃差得越多 —— 这是一个单调累积的系统性偏差, 不是随机噪声。
	 *
	 * 没法在接收侧识别: 两个适配器的 id 体系不同, 也没有共同标识能把“B 收到的这条
	 * 是 A 发的”对上号。因此只能在**发送侧**补偿 —— 框架只知道“今天我通过 A 发出了
	 * 一条”, 于是给 A 计一条, 把差值拉回 0。
	 *
	 * 计入探针而不是 @: 这与 B 侧收到它的方式对称。同时刷新 `lastProbeAt` —— 发送
	 * 成功是“这个适配器在工作”的强证据, 不刷新会让一个忙着回复的受理人被 @ 快速
	 * 通道误判成“彻底沉默”。
	 *
	 * @param adapter 实际执行发送的适配器 id
	 * @param at 发送成功的时刻(ms)
	 */
	credit(adapter: string, at: number): void {
		const probes = this.#probes.get(adapter);
		if (probes) probes.push(at);
		else this.#probes.set(adapter, [at]);

		const last = this.#lastAt.get(adapter);
		if (last === undefined || at > last) this.#lastAt.set(adapter, at);
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
	 * @ 快速通道要判断“受理人是不是彻底没动静了”, 用最近时刻比用计数更直接:
	 * 计数为 0 也可能是窗口还没攒够, 而“从未派发”与“很久没派发”是同一件事。
	 * 这里不受窗口裁剪影响 —— 静默一整天后仍应该知道它上一次是什么时候说过话。
	 */
	lastProbeAt(): Record<string, number> {
		return Object.fromEntries(this.#lastAt);
	}

	/** 清空全部计数 */
	clear(): void {
		this.#probes.clear();
		this.#mentions.clear();
		this.#lastAt.clear();
	}

	/**
	 * 丢弃窗口外的时刻, 返回窗口内的计数
	 *
	 * 两个 `counts` / `mentions` 入口都会走到这里, 所以裁剪发生在**消息路径上**;
	 * 静默期间不会有任何定时任务来动窗口 —— 窗口归零 ≠ 受理人作废。
	 */
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
