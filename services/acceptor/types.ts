/**
 * 受理人状态的形状
 *
 * 纯数据, 不含逻辑: 判定在 `detector.evaluate` 里, 存储与 IO 在 `index.ts` 里。
 */

/** 某个挑战者的累计证据 */
export type Score = {
	/** "非受理人活跃、受理人沉默"的累计次数 → 触发转移 */
	transfer: number;
	/** "原受理人复活且严格超过当前受理人"的累计次数 → 触发回切 */
	switchBack: number;
};

/** 一个 (bot, 逻辑会话) 的受理人状态 */
export type AcceptorState = {
	/** 当前受理人的适配器 id */
	acceptor: string;
	/** 成为受理人的时刻(ms) */
	since: number;
	/** 挑战者适配器 id -> 累计证据 */
	scores: Record<string, Score>;
	/** 非受理人连续"被 @ 且受理人沉默"的次数, 服务 @ 快速通道 */
	fastStreak: number;
	/** 冷却截止时刻(ms); 冷却期内不采纳回切证据 */
	cooldownUntil: number;
	/** 发生过多少次受理人变更, 用于区分"初始受理人"与"转移后的受理人" */
	transfers: number;
};

/** 判定参数: 全部来自配置, 每次评估现取 */
export type DetectorParams = {
	/** 滑动窗口长度(ms) */
	windowMs: number;
	/** 抑制转移所需的最小样本量(两端窗口计数之和) */
	minSamples: number;
	/** 窗口内不超过这个数就算"受理人沉默" */
	silenceThreshold: number;
	/** 相对差阈值: 差值要达到较大值的这个比例 */
	relativeGap: number;
	/** 抑制转移的最小绝对差: 差值小于它一律视为"两端接近" */
	minAbsoluteGap: number;
	/** 低速率兜底: 受理人还活着但差距足够大时的绝对阈值 */
	absoluteGap: number;
	/** 转移阈值: 证据次数超过它才真的转移 */
	transferThreshold: number;
	/** 回切阈值: 必须严格高于转移阈值 */
	switchBackThreshold: number;
	/** 冷却期(ms): 转移后这段时间内不采纳回切证据 */
	cooldownMs: number;
	fastPath: {
		enabled: boolean;
		/** 连续几次才触发 */
		consecutive: number;
		/** 受理人多久没有非 @ 派发就算"彻底沉默" */
		silenceMs: number;
	};
};

/** 一次评估的输入: 已由调用方从窗口与状态里取好的快照 */
export type DetectorInput = {
	/** 当前时刻(ms) */
	at: number;
	/** 这条事件来自哪个适配器 */
	adapter: string;
	/** 这条事件是否 @ 了本 Bot; `null` 表示平台未提供 */
	mentionedSelf: boolean | null;
	/** 窗口内每个适配器的非 @ 派发量 */
	counts: Record<string, number>;
	/** 每个适配器最近一次非 @ 派发的时刻 */
	lastProbeAt: Record<string, number>;
	/** 当前状态; 尚未选举时为 null */
	state: AcceptorState | null;
};

/** 一次评估的结果 */
export type Decision = {
	/** 当前这条事件是否放行给业务处理 */
	allow: boolean;
	/** 评估后的状态(新对象, 输入不被修改) */
	state: AcceptorState;
	/** 本次是否发生了受理人变更 */
	transferred: boolean;
	/** 人话原因, 直接进日志 */
	reason: string;
};

/* -------------------- WebUI 视图 -------------------- */

/** 逻辑会话里的一个平台会话 (来自 session link 表) */
export type AcceptorMember = {
	/** 平台名, 如 qq / onebot11 */
	platform: string;
	/** 会话类型: private / group / channel */
	type: string;
	/** 平台会话 ID */
	id: string;
};

/**
 * 一个逻辑会话的运行态快照
 *
 * 只读投影: 页面据此渲染"谁在受理、两边各派发了多少、证据攒到几", 不需要理解
 * 判定逻辑。`adapters` 是参与过这个会话的适配器(含当前受理人), 供手工切换用。
 */
export type AcceptorSessionView = {
	unionId: string;
	/** 当前受理人; 尚未选举时为 null */
	acceptor: string | null;
	/** 成为受理人的时刻(ms) */
	since: number | null;
	/** 受理人变更次数 */
	transfers: number;
	/** 冷却剩余(ms); 0 表示不在冷却期 */
	cooldownRemainingMs: number;
	/** 非受理人连续"被 @ 且受理人沉默"的次数 */
	fastStreak: number;
	/** 挑战者适配器 -> 累计证据 */
	scores: Record<string, Score>;
	/** 窗口内每个适配器的非 @ 派发量 */
	counts: Record<string, number>;
	/** 窗口内每个适配器的 @ 派发量 */
	mentions: Record<string, number>;
	/** 每个适配器最近一次非 @ 派发的时刻(ms) */
	lastProbeAt: Record<string, number>;
	/** 参与过本会话的适配器(已去重排序) */
	adapters: string[];
	/** 逻辑会话的成员; 查不到时为空数组 */
	members: AcceptorMember[];
};

/**
 * 一个 Bot 的受理人整体快照
 *
 * 页面只要一份这个就能画全: 模式(正式/演练)、当前参数与各会话的运行态。
 * 参数一并返回是有意的 —— 证据进度(1/2)离开阈值就没有意义, 分开两个请求容易
 * 让两者短暂不一致。
 *
 * **`sessions` 只是当前页**, 不是全部: 上千个群时把每一行都发过来(前端再把它们
 * 变成 DOM) 没有意义。总数在 `page.total`, 前端据此画分页。
 */
export type AcceptorSnapshot = {
	/** 判定是否开启 */
	enabled: boolean;
	/** 是否演练模式(只判定不拦截) */
	dryRun: boolean;
	/** 服务端当前时刻(ms), 用于把时间戳换算成"多久以前" */
	now: number;
	/** 滑动窗口长度(ms) */
	windowMs: number;
	thresholds: {
		minSamples: number;
		transferThreshold: number;
		switchBackThreshold: number;
		cooldownMs: number;
		relativeGap: number;
		minAbsoluteGap: number;
		absoluteGap: number;
	};
	fastPath: {
		enabled: boolean;
		consecutive: number;
		silenceMs: number;
	};
	/**
	 * 分页与查询状态 (原样回给前端)
	 *
	 * `offset` 可能被服务端夹到最后一页: 会话被清掉后前端手里那个 offset 会越界,
	 * 回一个空页会让用户以为“什么都没了”。
	 */
	page: AcceptorPage;
	/** 当前页的会话, 已按最近活跃排序 */
	sessions: AcceptorSessionView[];
};

/** 一次查询的分页参数与结果位置 */
export type AcceptorPage = {
	/** 服务端实际使用的关键字 (已 trim 与转小写) */
	query: string;
	/** 本页起点 */
	offset: number;
	/** 本页最大条数 */
	limit: number;
	/** 过滤后的总条数 */
	total: number;
};

/** 页面发来的查询参数; 全部可缺省 */
export type AcceptorQuery = {
	query?: string | undefined;
	offset?: number | undefined;
	limit?: number | undefined;
};
