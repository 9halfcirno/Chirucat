/**
 * 受理人服务检查: 滑动窗口、判定分支、模拟多适配器、模块契约。
 *
 * 分三层:
 * - `SlidingWindow` 与 `evaluate` 是纯逻辑, 时间由参数传入 —— 判定分支全部用构造
 *   时间戳驱动, 测试不需要真的等待;
 * - **模拟适配器**: 用几条"平台方言"把同一条真实消息分发给两个适配器。计数方案不看
 *   内容, 所以模拟只需要表达"这条消息它收到没有/是否 @ 了它", 不必再现卡片、动画
 *   表情之类的渲染差异 —— 那正是这个方案比逐条配对稳定的地方;
 * - 模块契约(`init` / `unload`)用假上下文跑一遍, 验证过滤器行为、dry-run、落盘与恢复。
 *
 * 用法:
 *   npx tsx scripts/check-acceptor-service.ts
 *
 * 全程在系统临时目录内完成, 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import acceptorModule, { readParams } from "../services/acceptor/index";
import { evaluate } from "../services/acceptor/detector";
import type { AcceptorState, DetectorInput, DetectorParams } from "../services/acceptor/types";
import { SlidingWindow } from "../services/acceptor/window";
import { KVStore } from "../src/plugin/contexts/apis/kv";
import { readProp } from "../src/utils/readProp";
import type { MessageCreateEvent } from "../src/protocols/event/message";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ""}`);
	}
}

/* ==================== 1. 滑动窗口 ==================== */

console.log("-- 滑动窗口 --");

{
	const w = new SlidingWindow();
	w.record("a", 1000, false);
	w.record("a", 2000, false);
	w.record("b", 2500, false);

	check("同一适配器累计计数", w.counts(2500, 60000)["a"] === 2, JSON.stringify(w.counts(2500, 60000)));
	check("不同适配器分开计数", w.counts(2500, 60000)["b"] === 1);
	check("窗口外的计数被排除", (w.counts(70000, 60000)["a"] ?? 0) === 0, JSON.stringify(w.counts(70000, 60000)));
}

{
	const w = new SlidingWindow();
	w.record("a", 1000, false);
	w.record("a", 10000, false);

	check("窗口边界: 窗口内只算最近一条", w.counts(11000, 5000)["a"] === 1, JSON.stringify(w.counts(11000, 5000)));
	check("窗口清理是幂等的", w.counts(11000, 5000)["a"] === 1);
}

{
	const w = new SlidingWindow();
	w.record("a", 1000, true);
	w.record("a", 2000, false);

	check("非 @ 计数不含 @ 消息", w.counts(2000, 60000)["a"] === 1, JSON.stringify(w.counts(2000, 60000)));
	check("@ 计数单独统计", w.mentions(2000, 60000)["a"] === 1, JSON.stringify(w.mentions(2000, 60000)));
}

{
	const w = new SlidingWindow();
	w.record("a", 1000, null);
	check("平台未提供 @ 信息时按非 @ 计数", w.counts(1000, 60000)["a"] === 1);
	check("平台未提供 @ 信息时不进 @ 计数", (w.mentions(1000, 60000)["a"] ?? 0) === 0);
}

{
	const w = new SlidingWindow();
	w.record("a", 1000, false);
	w.record("b", 5000, false);

	check("lastProbeAt 取最近一次非 @ 派发", w.lastProbeAt()["a"] === 1000 && w.lastProbeAt()["b"] === 5000);
	check("lastProbeAt 不影响计数", w.counts(5000, 60000)["a"] === 1);

	// 窗口裁剪只该动计数, 不该把“最近一次”一起抹掉 —— 静默后页面还要靠它列出可切换的适配器
	w.counts(900000, 60000);
	check("窗口裁剪后仍记得最近派发时刻",
		w.lastProbeAt()["a"] === 1000 && w.lastProbeAt()["b"] === 5000,
		JSON.stringify(w.lastProbeAt()));
	check("裁剪后窗口内计数确实归零", (w.counts(900000, 60000)["a"] ?? 0) === 0);
}

{
	// 窗口归零 ≠ 对象作废: 静默后同一份窗口能直接从 0 重新计数
	const w = new SlidingWindow();
	w.record("a", 1000, false);
	check("窗口内计数为 1", w.counts(1000, 1000)["a"] === 1, JSON.stringify(w.counts(1000, 1000)));
	check("静默后窗口计数归零", (w.counts(600000, 1000)["a"] ?? 0) === 0);
	w.record("a", 600001, false);
	check("静默后继续使用同一窗口能重新计数", w.counts(600001, 1000)["a"] === 1);
}

/* ==================== 2. 判定分支 ==================== */

console.log("-- 判定分支 --");

const PARAMS: DetectorParams = {
	windowMs: 60000,
	minSamples: 5,
	silenceThreshold: 0,
	relativeGap: 0.5,
	minAbsoluteGap: 3,
	absoluteGap: 5,
	transferThreshold: 2,
	switchBackThreshold: 4,
	cooldownMs: 300000,
	fastPath: { enabled: true, consecutive: 2, silenceMs: 15000 },
};

/** 构造一次评估输入 */
function input(overrides: Partial<DetectorInput> = {}): DetectorInput {
	return {
		at: 1000,
		adapter: "a",
		mentionedSelf: false,
		counts: {},
		lastProbeAt: {},
		state: null,
		...overrides,
	};
}

/** 一个已经选举好的状态 */
function elected(overrides: Partial<AcceptorState> = {}): AcceptorState {
	return {
		acceptor: "a",
		since: 0,
		scores: {},
		fastStreak: 0,
		cooldownUntil: 0,
		transfers: 0,
		...overrides,
	};
}

{
	const d = evaluate(PARAMS, input({ adapter: "b" }));
	check("没有受理人时首个派发者成为受理人", d.state.acceptor === "b" && d.allow === true, d.reason);
	check("初始化被标记为一次变更", d.transferred === true && d.state.transfers === 0);
}

{
	const d = evaluate(PARAMS, input({ state: elected() }));
	check("受理人自己派发时放行", d.allow === true);
	check("受理人放行不清空他人证据以外的字段", d.transferred === false);
}

{
	const d = evaluate(PARAMS, input({ state: elected({ fastStreak: 2 }) }));
	check("受理人派发时清掉 @ 连续计数", d.state.fastStreak === 0);
}

{
	// 两端计数接近 → 抑制转移
	const d = evaluate(PARAMS, input({
		adapter: "b",
		state: elected({ scores: { b: { transfer: 2, switchBack: 0 } } }),
		counts: { a: 10, b: 9 },
	}));
	check("两端接近时不转移", d.allow === false && d.transferred === false);
	check("两端接近时清空转移证据", d.state.scores["b"]?.transfer === 0, JSON.stringify(d.state.scores));
}

{
	// 样本量不足时不套用抑制规则(走后面的低速率兜底)
	const d = evaluate(PARAMS, input({
		adapter: "b",
		state: elected(),
		counts: { a: 1, b: 3 },
	}));
	check("样本量不足时不套用抑制规则", !d.reason.includes("抑制转移"), d.reason);
}

{
	// 受理人沉默 + 挑战者有足够样本 → 逐步累积, 超过阈值才转移
	let state = elected();
	const counts = { a: 0, b: 8 };

	const first = evaluate(PARAMS, input({ adapter: "b", state, counts }));
	state = first.state;
	check("第一次异常只累积证据", first.allow === false && first.transferred === false, first.reason);
	check("证据计数 +1", state.scores["b"]?.transfer === 1);

	const second = evaluate(PARAMS, input({ adapter: "b", state, counts }));
	state = second.state;
	check("第二次异常仍不转移(阈值未超)", second.transferred === false, second.reason);

	const third = evaluate(PARAMS, input({ adapter: "b", state, counts }));
	check("证据超过阈值后转移", third.transferred === true && third.state.acceptor === "b", third.reason);
	check("转移时放行当前事件", third.allow === true);
	check("转移后清空证据", Object.keys(third.state.scores).length === 0);
	check("转移后进入冷却期", third.state.cooldownUntil === 1000 + PARAMS.cooldownMs);
	check("转移次数被记录", third.state.transfers === 1);
}

{
	// 低速率兜底: 受理人沉默但挑战者样本不足, 单看差值
	const d = evaluate(PARAMS, input({
		adapter: "b",
		state: elected(),
		counts: { a: 0, b: 2 },
	}));
	check("样本不足但差值不够时不累积证据", (d.state.scores["b"]?.transfer ?? 0) === 0, JSON.stringify(d.state.scores));
}

{
	const d = evaluate(PARAMS, input({
		adapter: "b",
		state: elected(),
		counts: { a: 1, b: 7 },
	}));
	check("样本不足但差值够大时按兜底累积证据", d.state.scores["b"]?.transfer === 1, JSON.stringify(d.state.scores));
}

{
	// @ 快速通道: 连续两次 @ 且受理人沉默 → 立即转移
	let state = elected({ scores: { b: { transfer: 0, switchBack: 0 } } });
	const counts = { a: 0, b: 3 };
	const at = 100000; // 距离受理人最后一次派发(0) 已远超 15s

	const first = evaluate(PARAMS, input({
		at, adapter: "b", mentionedSelf: true, state, counts, lastProbeAt: { a: 0 },
	}));
	state = first.state;
	check("第一次 @ 只计数", first.transferred === false && state.fastStreak === 1, first.reason);

	const second = evaluate(PARAMS, input({
		at: at + 1000, adapter: "b", mentionedSelf: true, state, counts, lastProbeAt: { a: 0 },
	}));
	check("@ 快速通道连续两次后立即转移", second.transferred === true && second.state.acceptor === "b", second.reason);
	check("@ 快速通道不依赖转移阈值", second.state.transfers === 1);
}

{
	// 受理人还在活动 → 快速通道不成立, 计数被打断
	const state = elected({ fastStreak: 1 });
	const d = evaluate(PARAMS, input({
		at: 100000, adapter: "b", mentionedSelf: true, state,
		counts: { a: 5, b: 5 }, lastProbeAt: { a: 99000 },
	}));
	check("受理人活跃时 @ 快速通道不累积", d.state.fastStreak === 0, String(d.state.fastStreak));
	check("受理人活跃时 @ 消息仍不转移", d.transferred === false);
}

{
	// 非 @ 消息打断 @ 连续
	const state = elected({ fastStreak: 1 });
	const d = evaluate(PARAMS, input({
		at: 100000, adapter: "b", mentionedSelf: false, state,
		counts: { a: 0, b: 1 }, lastProbeAt: { a: 0 },
	}));
	check("非 @ 消息打断 @ 连续计数", d.state.fastStreak === 0);
}

{
	// 回切: 冷却期内不采纳
	const d = evaluate(PARAMS, input({
		at: 1000,
		adapter: "a",
		state: elected({ acceptor: "b", transfers: 1, cooldownUntil: 999999 }),
		counts: { a: 20, b: 1 },
	}));
	check("冷却期内不累积回切证据", (d.state.scores["a"]?.switchBack ?? 0) === 0, JSON.stringify(d.state.scores));
}

{
	// 回切: 冷却期已过且严格超过, 阈值更高
	let state = elected({ acceptor: "b", transfers: 1, cooldownUntil: 0 });
	const counts = { a: 20, b: 1 };

	for (let i = 0; i < PARAMS.switchBackThreshold; i++) {
		const d = evaluate(PARAMS, input({ at: 1000 + i, adapter: "a", state, counts }));
		state = d.state;
		check(`回切第 ${i + 1} 次只累积证据`, d.transferred === false, d.reason);
	}

	const after = evaluate(PARAMS, input({ at: 2000, adapter: "a", state, counts }));
	check("回切证据超过更高阈值后才切回", after.transferred === true && after.state.acceptor === "a", after.reason);
}

{
	// 初始受理人(未经转移)不走回切路径 —— 直接按转移路径处理
	let state = elected({ acceptor: "b", transfers: 0 });
	const counts = { a: 20, b: 1 };
	let transferred = false;
	for (let i = 0; i < 6 && !transferred; i++) {
		const d = evaluate(PARAMS, input({ at: 1000 + i, adapter: "a", state, counts }));
		state = d.state;
		transferred = d.transferred;
	}
	check("未经转移的受理人同样会被更快替换", transferred === true, JSON.stringify(state));
}

{
	// 证据按挑战者分开
	const state = elected();
	const one = evaluate(PARAMS, input({ adapter: "b", state, counts: { a: 0, b: 8 } }));
	const two = evaluate(PARAMS, input({ adapter: "c", state: one.state, counts: { a: 0, b: 8, c: 8 } }));
	check("证据按挑战者分开累计", two.state.scores["b"]?.transfer === 1 && two.state.scores["c"]?.transfer === 1,
		JSON.stringify(two.state.scores));
}

{
	// 纯函数: 输入状态不被修改
	const state = elected({ scores: { b: { transfer: 1, switchBack: 0 } } });
	evaluate(PARAMS, input({ adapter: "b", state, counts: { a: 0, b: 8 } }));
	check("评估不修改传入的状态", state.scores["b"]?.transfer === 1, JSON.stringify(state.scores));
}

/* ==================== 3. 配置路径 ==================== */
console.log("-- 配置路径 --");

{
	// WebUI 的 group 控件会把子控件嵌在组名下, 路径写错就会静默地一直用默认值
	const nested = {
		window: { windowMs: 12345, flushIntervalMs: 5000 },
		thresholds: {
			minSamples: 7,
			silenceThreshold: 2,
			relativeGap: 0.3,
			minAbsoluteGap: 4,
			absoluteGap: 6,
			transferThreshold: 3,
			switchBackThreshold: 5,
			cooldownMs: 1000,
		},
		fastPath: { enabled: false, consecutive: 3, silenceMs: 2000 },
	};
	const params = readParams({
		config: { get: (key: string, fallback?: unknown) => readProp(nested, key) ?? fallback },
	} as any);

	check("读取 window.* 组", params.windowMs === 12345, String(params.windowMs));
	check("读取 thresholds.* 组",
		params.minSamples === 7 && params.silenceThreshold === 2 && params.relativeGap === 0.3
		&& params.minAbsoluteGap === 4 && params.absoluteGap === 6
		&& params.transferThreshold === 3 && params.switchBackThreshold === 5 && params.cooldownMs === 1000,
		JSON.stringify(params));
	check("读取 fastPath.* 组",
		params.fastPath.enabled === false && params.fastPath.consecutive === 3 && params.fastPath.silenceMs === 2000,
		JSON.stringify(params.fastPath));
}

{
	// 配置为空时全部退回默认值
	const params = readParams({ config: { get: (_key: string, fallback?: unknown) => fallback } } as any);
	check("配置缺省时全部回退到默认值",
		params.windowMs === 60000 && params.minSamples === 5 && params.transferThreshold === 2
		&& params.switchBackThreshold === 4 && params.fastPath.enabled === true,
		JSON.stringify(params));
	check("回切阈值高于转移阈值", params.switchBackThreshold > params.transferThreshold);
}

{
	// 配置被写成非法值(0/负数/非数字)时也回退, 不能按 0 毫秒窗口跑
	const params = readParams({
		config: { get: (key: string) => (key === "window.windowMs" ? 0 : key === "thresholds.minSamples" ? -1 : "x") },
	} as any);
	check("非法配置回退到默认值", params.windowMs === 60000 && params.minSamples === 5);
	check("允许为 0 的项保持 0", readParams({
		config: { get: (key: string, fallback?: unknown) => (key === "thresholds.silenceThreshold" ? 0 : fallback) },
	} as any).silenceThreshold === 0);
}

/* ==================== 4. 模拟多适配器 ==================== */


console.log("-- 模拟多适配器 --");

/**
 * 一个适配器的接收能力
 *
 * - `full: true` —— 开了全量消息, 群里所有消息都收得到;
 * - `full: false` —— 只收得到 @ 自己的消息(QQ 未开通全量时的真实情形)。
 */
type AdapterPolicy = { full: boolean };

/**
 * 一条真实消息: 与平台无关
 *
 * 计数方案只关心"哪个适配器收到了、是否 @ 了它"。同一条消息在不同平台上的渲染
 * 结果(卡片/封面图、动画表情/占位文本)完全不影响判定, 所以模拟不需要再现它们 ——
 * 这正是计数方案比逐条内容配对稳定的地方。
 */
type RealMessage = {
	/** 真实到达时刻 */
	at: number;
	/** @ 的适配器; `null` 表示没 @ 任何机器人 */
	atAdapter: string | null;
	/** 收不到这条消息的适配器(账号死亡/被风控/不在群里) */
	missing?: string[];
};

type Delivery = { adapter: string; at: number; mentionedSelf: boolean | null };

/** 按各适配器的接收能力投递一条真实消息 */
function deliver(msg: RealMessage, policies: Record<string, AdapterPolicy>): Delivery[] {
	const out: Delivery[] = [];

	for (const [adapter, policy] of Object.entries(policies)) {
		if (msg.missing?.includes(adapter)) continue;

		const isAt = msg.atAdapter === adapter;
		if (!policy.full && !isAt) continue;

		out.push({
			adapter,
			at: msg.at,
			// 没 @ 任何人 → 明确 false; @ 了某人 → 只有被 @ 的那个是真
			mentionedSelf: msg.atAdapter === null ? false : isAt,
		});
	}

	return out;
}

/** 用模拟投递驱动判定 */
function run(
	messages: RealMessage[],
	policies: Record<string, AdapterPolicy>,
	params: DetectorParams = PARAMS,
): { state: AcceptorState | null; allowed: string[]; transfers: string[] } {
	let state: AcceptorState | null = null;
	const window = new SlidingWindow();
	const allowed: string[] = [];
	const transfers: string[] = [];

	for (const msg of messages) {
		for (const delivery of deliver(msg, policies)) {
			window.record(delivery.adapter, delivery.at, delivery.mentionedSelf);

			const before = state?.transfers ?? 0;
			const decision = evaluate(params, {
				at: delivery.at,
				adapter: delivery.adapter,
				mentionedSelf: delivery.mentionedSelf,
				counts: window.counts(delivery.at, params.windowMs),
				lastProbeAt: window.lastProbeAt(),
				state,
			});

			state = decision.state;
			if (decision.allow) allowed.push(delivery.adapter);
			// 初始化不算转移: 只有 transfers 真的增加才记
			if (decision.state.transfers > before) transfers.push(`${decision.state.acceptor}: ${decision.reason}`);
		}
	}

	return { state, allowed, transfers };
}

/** 生成 n 条普通消息, 每隔 step 毫秒一条 */
function burst(from: number, n: number, step: number, atAdapter: string | null = null): RealMessage[] {
	return Array.from({ length: n }, (_, i) => ({ at: from + i * step, atAdapter }));
}

const BOTH_FULL: Record<string, AdapterPolicy> = { a: { full: true }, b: { full: true } };

{
	const result = run(burst(1000, 10, 1000), BOTH_FULL);
	check("两端都收到时每条消息只放行一次", result.allowed.length === 10, String(result.allowed.length));
	check("放行的永远是同一个适配器", new Set(result.allowed).size === 1, result.allowed.join(","));
	check("正常聊天不触发转移", result.transfers.length === 0, result.transfers.join(","));
	check("首个派发者成为受理人", result.state?.acceptor === "a", String(result.state?.acceptor));
}

{
	// a 在中间停止收到消息(账号死亡/被风控) —— b 仍在全量接收
	// 第二段拉开到窗口外, 让 a 的旧计数自然过期, 这才是“受理人沉默”的形态
	const messages: RealMessage[] = [
		...burst(1000, 10, 1000),
		...burst(80000, 12, 1000).map(m => ({ ...m, missing: ["a"] })),
	];
	const result = run(messages, BOTH_FULL);

	check("一端停止接收后最终转移到另一端", result.state?.acceptor === "b", String(result.state?.acceptor));
	check("转移被记录且原因是沉默", result.transfers.some(t => t.includes("沉默")), result.transfers.join(","));
	check("转移后 b 的事件被放行", result.allowed.includes("b"), result.allowed.join(","));
	check("转移后 a 不再放行", result.allowed.lastIndexOf("a") < result.allowed.indexOf("b"), result.allowed.join(","));
}

{
	// 两端都在, 但 b 只开了 @: 普通聊天由 a 受理, @ b 时靠快速通道转移
	const policies: Record<string, AdapterPolicy> = { a: { full: true }, b: { full: false } };
	const messages: RealMessage[] = [
		...burst(1000, 10, 1000),
		// a 此时已经收不到消息, 用户连续 @ b
		{ at: 40000, atAdapter: "b", missing: ["a"] },
		{ at: 41000, atAdapter: "b", missing: ["a"] },
	];
	const result = run(messages, policies);

	check("只开 @ 的一端因快速通道接管", result.state?.acceptor === "b", String(result.state?.acceptor));
	check("转移原因是 @ 快速通道", result.transfers.some(t => t.includes("快速通道")), result.transfers.join(","));
	check("快速通道转移后 @ 它的消息被放行", result.allowed.includes("b"), result.allowed.join(","));
}

{
	// 群里安静时两端都没有流量: 不该凭空转移
	const result = run(burst(1000, 3, 1000), BOTH_FULL);
	check("低流量下不误判转移", result.transfers.length === 0, result.transfers.join(","));
}

{
	// 单一适配器: 永远自己受理
	const result = run(burst(1000, 5, 1000), { only: { full: true } });
	check("只有一个适配器时全部放行", result.allowed.length === 5, String(result.allowed.length));
	check("只有一个适配器时不会转移", result.transfers.length === 0);
}

/*
 * 回声: 受理人的回复会被另一个适配器当成入站消息收到
 *
 * 这是实测出来的那个 bug: 两端差值恰好等于“bot 通过受理人发了多少条”, 是一个
 * 单调累积的系统性偏差。下面用带回声的完整模拟对比三种情形:
 * - 无回声(基准): 两端计数完全对称;
 * - 有回声但不补偿: 差值逐轮递增, 最终把受理人推走;
 * - 有回声且补偿(发送侧 credit): 差值回到 0, 受理人不变。
 */
console.log("-- 回声补偿 --");

/**
 * 带回声的完整模拟
 *
 * 与 {@link run} 的差别: 被放行的消息意味着“受理人回了一条”, 其他全量适配器会
 * 把这条回复当成入站消息收到。回声本身也走一次判定(真实系统里它确实会进 filter),
 * 但不递归产生二次回声 —— 那会变成无限反省, 与实测现象无关。
 */
function simulate(
	messages: RealMessage[],
	policies: Record<string, AdapterPolicy>,
	options: { compensate?: boolean; reply?: boolean; replies?: number } = {},
): { state: AcceptorState | null; allowed: string[]; transfers: string[]; counts: Record<string, number> } {
	const compensate = options.compensate ?? false;
	const reply = options.reply ?? true;
	/** 一次回复发几条: QQ 适配器遇到“文本+媒体”会拆成多条请求 (真实存在) */
	const replies = Math.max(1, options.replies ?? 1);

	let state: AcceptorState | null = null;
	const window = new SlidingWindow();
	const allowed: string[] = [];
	const transfers: string[] = [];
	const echoQueue: Delivery[] = [];

	/** 处理一个事件 (真实消息或回声) */
	function handle(event: Delivery): boolean {
		window.record(event.adapter, event.at, event.mentionedSelf);

		const before = state?.transfers ?? 0;
		const decision = evaluate(PARAMS, {
			at: event.at,
			adapter: event.adapter,
			mentionedSelf: event.mentionedSelf,
			counts: window.counts(event.at, PARAMS.windowMs),
			lastProbeAt: window.lastProbeAt(),
			state,
		});

		state = decision.state;
		if (decision.state.transfers > before) transfers.push(`${decision.state.acceptor}: ${decision.reason}`);
		return decision.allow;
	}

	for (const msg of messages) {
		for (const delivery of deliver(msg, policies)) {
			if (!handle(delivery)) continue;
			allowed.push(delivery.adapter);

			if (!reply) continue;

			// 发送侧补偿: 动作只报告**一次**成功, 所以无论实际发了几条都只补 1 条。
			// 这一如实反映实现的保守度: 多段回复只能部分抵消, 但已足够拉回抑制区。
			if (compensate) window.credit(delivery.adapter, delivery.at + 1);

			for (let i = 0; i < replies; i++) {
				const replyAt = delivery.at + 1 + i;

				// 回声: 除发送方以外、开了全量的适配器会收到这每一条回复
				for (const [adapter, policy] of Object.entries(policies)) {
					if (adapter === delivery.adapter || !policy.full) continue;
					echoQueue.push({ adapter, at: replyAt, mentionedSelf: false });
				}
			}
		}

		// 本轮回声在下一轮真实消息之前消化完
		while (echoQueue.length > 0) handle(echoQueue.shift()!);
	}

	const lastAt = messages[messages.length - 1]?.at ?? 0;
	return { state, allowed, transfers, counts: window.counts(lastAt + 10, PARAMS.windowMs) };
}

const busyChat = burst(1000, 6, 1000);

{
	// 基准: 机器人从不在群里说话, 两端应当一直对称
	const result = simulate(busyChat, BOTH_FULL, { reply: false });
	check("不说话时两端计数对称", result.counts.a === result.counts.b, JSON.stringify(result.counts));
	check("不说话时不转移", result.transfers.length === 0, result.transfers.join(","));
}

{
	// 根因: 回声全落在另一端, 差值恰好等于“bot 通过受理人发了多少条”
	const result = simulate(busyChat, BOTH_FULL, { compensate: false });
	check("有回声且不补偿时差值随发言单调增长",
		(result.counts.b ?? 0) - (result.counts.a ?? 0) >= 5,
		JSON.stringify(result.counts));
	check("差值正好等于回复条数",
		(result.counts.b ?? 0) === 12 && (result.counts.a ?? 0) === 6,
		JSON.stringify(result.counts));
}

{
	// 实测现象的完整复现: 一次回复拆成两条(文本+媒体)时, 差值比例跨过 0.5,
	// 抑制规则失效, 证据逐轮累积直到把受理人推走。
	const result = simulate(busyChat, BOTH_FULL, { compensate: false, replies: 2 });
	check("多段回复+不补偿时真会把受理人推走",
		result.transfers.length > 0,
		result.transfers.join(","));
	check("被推走的是原本不发言的那一端",
		result.transfers[0]?.startsWith("b:"),
		result.transfers.join(","));
}

{
	// 补偿 1 条就能拉回抑制区 —— 即使实际发了 2 条(只补得起 1 条)也是如此:
	// 差值从 2n 降到 n, 比例 1/3 < relativeGap 0.5。
	const result = simulate(busyChat, BOTH_FULL, { compensate: true, replies: 2 });
	check("多段回复+补偿后不再转移",
		result.transfers.length === 0,
		result.transfers.join(","));
	check("多段回复+补偿后受理人不变",
		result.state?.acceptor === "a",
		String(result.state?.acceptor));
}

{
	// 单条回复是即将推行的常态(QQ 全 md 发送), 补偿后应当完全对称
	const result = simulate(busyChat, BOTH_FULL, { compensate: true });
	check("补偿后两端计数重新对称",
		result.counts.a === result.counts.b,
		JSON.stringify(result.counts));
	check("补偿后受理人不变",
		result.transfers.length === 0,
		result.transfers.join(","));
	check("补偿后受理人仍是首个派发者",
		result.state?.acceptor === "a",
		String(result.state?.acceptor));
}

{
	// 补偿不能掩盖真实故障: 受理人死了仍应转移
	// 前 3 条两端都收到(让 a 当选), 之后 a 收不到
	const doomed: RealMessage[] = [
		...burst(1000, 3, 1000),
		...burst(4000, 8, 1000).map(msg => ({ ...msg, missing: ["a"] })),
	];
	const result = simulate(doomed, BOTH_FULL, { compensate: true });
	check("补偿不影响真实故障的转移",
		result.transfers.length > 0,
		result.transfers.join(","));
}

{
	// 只开 @ 的一端收不到回声, 补偿在它身上也不该凭空造出计数
	const result = simulate(busyChat, { a: { full: true }, b: { full: false } }, { compensate: true });
	check("只有一端全量时不会凭空造出另一端的计数",
		(result.counts.b ?? 0) === 0,
		JSON.stringify(result.counts));
}

/* ==================== 5. 模块契约 ==================== */

console.log("-- 模块契约 --");

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-acceptor-"));
const pluginDir = path.resolve("services", "acceptor");
console.log(`临时数据目录: ${dataDir}\n`);

type FilterHandler = (event: any, bot: any, meta: any) => boolean;

let registeredFilter: FilterHandler | null = null;
const logs: string[] = [];

/** 最近一次 init 注册的 WebUI 端点与页面 (每个假上下文一份) */
let uiRoutes: any[] = [];
let uiPages: any[] = [];
/** 注册的 hook: name -> handler */
let hookHandlers: Record<string, (data: any) => unknown> = {};

/** 假上下文: 只实现本服务用到的那几项 */
function createCtx(kv: KVStore, settings: Record<string, unknown> = {}) {
	uiRoutes = [];
	uiPages = [];
	hookHandlers = {};

	const ctx = {
		path: { data: dataDir, plugin: pluginDir },
		logger: {
			log: (m: string) => { logs.push(String(m)); },
			warn: (m: string) => { logs.push(`WARN ${String(m)}`); },
			error: (m: string) => { logs.push(`ERROR ${String(m)}`); },
		},
		event: {
			filter: (fn: FilterHandler) => { registeredFilter = fn; },
			observe: () => { throw new Error("记录入口在 filter 里, 不该用 observe"); },
		},
		config: {
			get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
			watch: () => () => { /* 测试里不改配置 */ },
		},
		hook: {
			register: (name: string, handler: (data: any) => unknown) => {
				hookHandlers[name] = handler;
				return () => { delete hookHandlers[name]; };
			},
		},
		core: {
			session: {
				unionOf: (id: string) => (id.startsWith("u:") ? id.slice(2) : null),
				// 成员列表固定成两个平台: 编辑页面要能看到“这个逻辑会话里有谁”
				listMembers: (unionId: string) => [
					{ sessionId: `s-qq-${unionId}`, platform: "qq", type: "group", id: `qq-${unionId}` },
					{ sessionId: `s-ob-${unionId}`, platform: "onebot11", type: "group", id: `ob-${unionId}` },
				],
			},
			webui: {
				register: (route: any) => { uiRoutes.push(route); return () => { /* 测试不注销 */ }; },
				bot: {
					pages: {
						register: (page: any) => { uiPages.push(page); return () => { /* 测试不注销 */ }; },
					},
				},
			},
		},
		kv,
	} as any;

	return ctx;
}

function messageEvent(sessionId = "u:union-1"): MessageCreateEvent {
	return {
		type: "message.create",
		messageId: "m1",
		quoteToken: "",
		senderId: "user-1",
		senderName: "某用户",
		sessionType: "group",
		sessionId,
		text: "hello",
		richContent: [{ type: "text", text: "hello" }],
		time: Date.now(),
		platform: "qq",
	} as MessageCreateEvent;
}

/** 每次取当前注册的过滤器: 重新 init 会替换它 */
const runFilter: FilterHandler = (event, bot, meta) => (registeredFilter as FilterHandler)(event, bot, meta);

const bot = { id: "bot-1" };
const meta = (adapter: string) => ({ adapter, bot: "bot-1" });

const kvFile = path.join(dataDir, ".kv.db");
const ctx1 = createCtx(new KVStore(kvFile), { dryRun: true });

acceptorModule.init(ctx1);
check("init 注册了事件过滤器", typeof registeredFilter === "function");

// ---- WebUI 注册: 端口与 Bot 页面 ----
check("init 注册了受理人端点",
	uiRoutes.some(route => route.path === "acceptor_state" && route.method === "POST" && route.auth === true));
check("init 注册了 Bot 详情页面",
	uiPages.some(page => page.id === "acceptor" && page.module === "bot.js" && page.order === 40));

// 页面模块与样式必须真实存在: 注册表不检查文件, 写错名字只会在浏览器里 404
for (const file of ["bot.js", "acceptor.css", "acceptor.svg"]) {
	const stat = await fs.stat(path.join(pluginDir, "public", file)).catch(() => null);
	check(`页面资源存在: ${file}`, !!stat?.isFile(), path.join("services/acceptor/public", file));
}

check("dry-run 下首个适配器的事件放行", runFilter(messageEvent(), bot, meta("a")) === true);
check("dry-run 下非受理人的事件也放行", runFilter(messageEvent(), bot, meta("b")) === true);

const exported = ctx1.exports as {
	state(botId: string, unionId: string): AcceptorState | null;
	all(): Record<string, AcceptorState | null>;
	override(botId: string, unionId: string, adapter: string, at?: number): void;
	reset(): void;
};

check("dry-run 也会选举受理人", exported.state("bot-1", "union-1")?.acceptor === "a",
	String(exported.state("bot-1", "union-1")?.acceptor));

// dry-run 关掉: 非受理人会被拦
acceptorModule.unload(ctx1);
const ctx2 = createCtx(new KVStore(path.join(dataDir, "real.db")), { dryRun: false });
acceptorModule.init(ctx2);
const exported2 = ctx2.exports as typeof exported;

check("正式模式下首个适配器放行", runFilter(messageEvent(), bot, meta("a")) === true);
check("正式模式下非受理人被拦", runFilter(messageEvent(), bot, meta("b")) === false);
check("正式模式下受理人继续放行", runFilter(messageEvent(), bot, meta("a")) === true);
check("同一会话始终只有一个受理人", exported2.state("bot-1", "union-1")?.acceptor === "a");

// 不同会话互不影响
check("另一个会话独立选举", runFilter(messageEvent("u:union-2"), bot, meta("b")) === true);
check("另一个会话的受理人是它自己的首个派发者", exported2.state("bot-1", "union-2")?.acceptor === "b",
	String(exported2.state("bot-1", "union-2")?.acceptor));
check("两个会话的受理人互不干扰",
	exported2.state("bot-1", "union-1")?.acceptor === "a" && exported2.state("bot-1", "union-2")?.acceptor === "b");

// 没有逻辑会话组的消息一律放行
check("没有逻辑会话组时放行", runFilter(messageEvent("plain-session"), bot, meta("b")) === true);

// 非消息事件与非观察会话类型一律放行
check("非 message.create 放行", runFilter(
	{ type: "message.delete", time: 1, platform: "qq", sessionType: "group", sessionId: "u:union-1" } as any,
	bot, meta("b"),
) === true);
check("非观察的会话类型放行", runFilter(
	{ ...messageEvent("u:union-3"), sessionType: "private" } as any, bot, meta("b"),
) === true);
check("非观察的会话类型不建立状态", exported2.state("bot-1", "union-3") === null);

// 手工指定受理人
exported2.override("bot-1", "union-1", "b");
check("override 立即改受理人", exported2.state("bot-1", "union-1")?.acceptor === "b");
check("override 后原受理人被拦", runFilter(messageEvent(), bot, meta("a")) === false);
check("override 后新受理人放行", runFilter(messageEvent(), bot, meta("b")) === true);

// ---- WebUI 端点行为 ----
const endpoint = uiRoutes.find(route => route.path === "acceptor_state")?.handler as
	((body: unknown) => any) | undefined;
check("端点 handler 可用", typeof endpoint === "function");

const snapshot = endpoint!({ action: "state", botId: "bot-1" });
check("端点只返回当前 Bot 的会话", snapshot.sessions.length === 2, String(snapshot.sessions.length));
check("端点带出窗口计数", (snapshot.sessions.find((s: any) => s.unionId === "union-1")?.counts.a ?? 0) >= 1,
	JSON.stringify(snapshot.sessions.map((s: any) => [s.unionId, s.counts])));
check("端点带出逻辑会话成员", snapshot.sessions.every((s: any) => s.members.length === 2));
check("端点带出模式与阈值", snapshot.dryRun === false && snapshot.thresholds.transferThreshold === 2);
check("端点带出可选适配器", snapshot.sessions.every((s: any) => s.adapters.includes(s.acceptor)),
	JSON.stringify(snapshot.sessions.map((s: any) => [s.acceptor, s.adapters])));

const empty = endpoint!({ action: "state", botId: "bot-9" });
check("别的 Bot 看不到这些会话", empty.sessions.length === 0, String(empty.sessions.length));

// 把受理人设成一个没见过的适配器 = 这个会话永久没人放行, 必须在边界上拒绝
let rejectedCode = 0;
try {
	endpoint!({ action: "override", botId: "bot-1", unionId: "union-1", adapter: "ghost" });
} catch (e: any) {
	rejectedCode = e?.code ?? 0;
}
check("未知适配器被拒绝(400)", rejectedCode === 400, String(rejectedCode));

let badActionCode = 0;
try {
	endpoint!({ action: "nope", botId: "bot-1" });
} catch (e: any) {
	badActionCode = e?.code ?? 0;
}
check("未知 action 被拒绝(400)", badActionCode === 400, String(badActionCode));

// 清一个会话不能连带另一个
const afterReset = endpoint!({ action: "reset", botId: "bot-1", unionId: "union-2" });
check("reset 只清目标会话",
	exported2.state("bot-1", "union-1") !== null && exported2.state("bot-1", "union-2") === null);
check("reset 后端点只剩一个会话", afterReset.sessions.length === 1, String(afterReset.sessions.length));

// ---- 分页与查询 ----
// 上千个群不可能一页画完: 服务端只回当前页, 总数单独给
for (let i = 0; i < 45; i++) {
	runFilter(messageEvent(`u:bulk-${String(i).padStart(2, "0")}`), bot, meta(i % 2 === 0 ? "a" : "b"));
}

const firstPage = endpoint!({ action: "state", botId: "bot-1", limit: 10 });
check("默认带上分页信息", !!firstPage.page, JSON.stringify(firstPage.page));
check("只回当前页的会话", firstPage.sessions.length === 10, String(firstPage.sessions.length));
check("总数是过滤后的全部会话", firstPage.page.total === 46, String(firstPage.page.total));
check("首页 offset 为 0", firstPage.page.offset === 0, String(firstPage.page.offset));

const secondPage = endpoint!({ action: "state", botId: "bot-1", limit: 10, offset: 10 });
check("第二页 offset 生效", secondPage.page.offset === 10, String(secondPage.page.offset));
check("两页不重叠",
	!secondPage.sessions.some((s: any) => firstPage.sessions.some((f: any) => f.unionId === s.unionId)));
check("两页数量都满", secondPage.sessions.length === 10, String(secondPage.sessions.length));

const lastPage = endpoint!({ action: "state", botId: "bot-1", limit: 10, offset: 40 });
check("最后一页装剩下的", lastPage.sessions.length === 6, String(lastPage.sessions.length));

// offset 越界必须夹回最后一页: 清掉会话后前端手里那个 offset 会失效
const overflow = endpoint!({ action: "state", botId: "bot-1", limit: 10, offset: 999 });
check("offset 越界时夹到最后一页",
	overflow.page.offset === 40 && overflow.sessions.length === 6,
	`offset=${overflow.page.offset} len=${overflow.sessions.length}`);

const defaultLimit = endpoint!({ action: "state", botId: "bot-1" });
check("缺省每页 20 条", defaultLimit.page.limit === 20 && defaultLimit.sessions.length === 20,
	`limit=${defaultLimit.page.limit} len=${defaultLimit.sessions.length}`);

// 查询: 能按 unionId / 成员 id / 适配器名命中
const byUnion = endpoint!({ action: "state", botId: "bot-1", query: "bulk-07" });
check("按 unionId 搜索",
	byUnion.page.total === 1 && byUnion.sessions[0]?.unionId === "bulk-07",
	`${byUnion.page.total} ${JSON.stringify(byUnion.sessions.map((s: any) => s.unionId))}`);

const byMember = endpoint!({ action: "state", botId: "bot-1", query: "qq-union-1" });
check("按成员平台会话 ID 搜索", byMember.page.total === 1, String(byMember.page.total));

// mock 的成员固定带一个 onebot11 平台, 所以除了刚被 reset 的 union-2, 其余会话都能命中
const byPlatform = endpoint!({ action: "state", botId: "bot-1", query: "ONEBOT", limit: 200 });
check("按成员平台名搜索(大小写无关)",
	byPlatform.page.total === 46 && byPlatform.sessions.every((s: any) =>
		s.members.some((m: any) => m.platform === "onebot11")),
	`${byPlatform.page.total} ${byPlatform.sessions.length}`);

const noMatch = endpoint!({ action: "state", botId: "bot-1", query: "nonexistent-xyz" });
check("搜索无命中时返回空列表与 0 总数",
	noMatch.page.total === 0 && noMatch.sessions.length === 0, String(noMatch.page.total));

// 搜索后翻页仍是搜索范围内的分页
const queryPaged = endpoint!({ action: "state", botId: "bot-1", query: "bulk", limit: 10, offset: 10 });
check("搜索后仍能翻页",
	queryPaged.page.total === 45 && queryPaged.sessions.length === 10 && queryPaged.page.offset === 10,
	`${queryPaged.page.total} ${queryPaged.sessions.length} ${queryPaged.page.offset}`);

// 非法分页参数必须报错, 而不是默默当成 0
for (const bad of [{ offset: -1 }, { limit: "10" }, { offset: 1.5 }]) {
	let code = 0;
	try {
		endpoint!({ action: "state", botId: "bot-1", ...bad });
	} catch (e: any) {
		code = e?.code ?? 0;
	}
	// offset: 1.5 是非负数, 允许(向下取整); 另外两个必须被拒
	const shouldReject = !("offset" in bad && bad.offset === 1.5);
	check(`非法分页参数 ${JSON.stringify(bad)} ${shouldReject ? "被拒绝(400)" : "向下取整"}`,
		shouldReject ? code === 400 : code === 0, String(code));
}

// 换人/清空也要停在当前页: 否则操作一下就被踢回第一页
// 注: override 会刷新 `since`, 该行按“最近活跃优先”会跳到第一页 —— 这是排页语义的
// 自然结果, 不是缺陷; 这里只验证“位置不被重置”。
const overridePaged = endpoint!({ action: "override", botId: "bot-1", unionId: "bulk-02", adapter: "a",
	limit: 10, offset: 10 });
check("override 后仍停在原页",
	overridePaged.page.offset === 10 && overridePaged.sessions.length === 10,
	`offset=${overridePaged.page.offset} len=${overridePaged.sessions.length}`);

// 落盘与恢复
acceptorModule.unload(ctx2);
check("卸载时输出汇总日志", logs.some(l => l.includes("[受理人]")), logs.join("\n"));
check("卸载时把状态写入 KV", (ctx2.kv as KVStore).count("acceptor:v1:") >= 1, String((ctx2.kv as KVStore).count("acceptor:v1:")));
(ctx2.kv as KVStore).close();

const ctx3 = createCtx(new KVStore(kvFile), { dryRun: false });
acceptorModule.init(ctx3);
const restored = ctx3.exports as typeof exported;
check("重启后恢复受理人", restored.state("bot-1", "union-1")?.acceptor === "a",
	String(restored.state("bot-1", "union-1")?.acceptor));
acceptorModule.unload(ctx3);
(ctx3.kv as KVStore).close();
(ctx1.kv as KVStore).close();

// reset 清空内存与落盘
const ctx4 = createCtx(new KVStore(path.join(dataDir, "reset.db")), { dryRun: false });
acceptorModule.init(ctx4);
runFilter(messageEvent(), bot, meta("a"));
check("reset 前有状态", (ctx4.exports as typeof exported).state("bot-1", "union-1") !== null);
(ctx4.exports as typeof exported).reset();
check("reset 清空内存状态", (ctx4.exports as typeof exported).state("bot-1", "union-1") === null);
check("reset 清空落盘状态", (ctx4.kv as KVStore).count("acceptor:v1:") === 0);
acceptorModule.unload(ctx4);
(ctx4.kv as KVStore).close();

// enabled=false: 完全不判定
const ctx5 = createCtx(new KVStore(path.join(dataDir, "off.db")), { enabled: false, dryRun: false });
acceptorModule.init(ctx5);
check("enabled=false 时全部放行", runFilter(messageEvent(), bot, meta("a")) === true
	&& runFilter(messageEvent(), bot, meta("b")) === true);
check("enabled=false 时不建立状态", (ctx5.exports as typeof exported).state("bot-1", "union-1") === null);
acceptorModule.unload(ctx5);
(ctx5.kv as KVStore).close();

// ---- 回声补偿的接线 (直接调 hook, 不经模拟) ----
const ctx8 = createCtx(new KVStore(path.join(dataDir, "echo.db")), { dryRun: false });
acceptorModule.init(ctx8);

const echoHook = hookHandlers["after.action.send"];
check("init 注册了 after.action.send", typeof echoHook === "function");

const exported8 = ctx8.exports as typeof exported;
const endpoint8 = uiRoutes.find(route => route.path === "acceptor_state")?.handler as
	((body: unknown) => any) | undefined;
const view8 = () => endpoint8!({ action: "state", botId: "bot-1" });
const counts8 = () => view8().sessions[0]?.counts ?? {};

/** 构造一个发送完成事件 */
const sent = (adapter: string, session: string, extra: Record<string, unknown> = {}) => ({
	action: { type: "message.send", session, message: "hi" },
	adapter,
	bot: "bot-1",
	response: { success: true, id: "m-new" },
	extra: undefined,
	...extra,
});

runFilter(messageEvent("u:echo-1"), bot, meta("a")); // a 当选
const beforeEcho = counts8();
echoHook!(sent("a", "u:echo-1"));
const afterEcho = counts8();

check("发送成功后给发送方 +1",
	(afterEcho.a ?? 0) === (beforeEcho.a ?? 0) + 1,
	`${JSON.stringify(beforeEcho)} -> ${JSON.stringify(afterEcho)}`);
check("补偿不会记到另一端头上", (afterEcho.b ?? 0) === 0, JSON.stringify(afterEcho));
check("补偿刷新了最近派发时刻",
	(view8().sessions[0]?.lastProbeAt?.a ?? 0) >= (beforeEcho.a ?? 0),
	JSON.stringify(view8().sessions[0]?.lastProbeAt));

// 退回、失败、未绑定、从未参与判定: 都不该产生计数
echoHook!({
	action: { type: "message.delete", session: "u:echo-1", id: "m1" },
	adapter: "a", bot: "bot-1", response: { success: true }, extra: undefined,
});
check("撤回不产生补偿", (counts8().a ?? 0) === (afterEcho.a ?? 0), JSON.stringify(counts8()));

echoHook!({
	action: { type: "message.send", session: "u:echo-1", message: "hi" },
	adapter: "a", bot: "bot-1",
	response: { success: false, error: "boom", code: "UNKNOWN_ERROR" }, extra: undefined,
});
check("发送失败不产生补偿", (counts8().a ?? 0) === (afterEcho.a ?? 0), JSON.stringify(counts8()));

echoHook!(sent("b", "plain-session"));
check("没有逻辑会话组时不补偿", exported8.state("bot-1", "") === null && (counts8().b ?? 0) === 0,
	JSON.stringify(counts8()));

echoHook!(sent("b", "u:never-seen"));
check("从未参与判定的会话不会被凭空建出来",
	view8().sessions.length === 1,
	JSON.stringify(view8().sessions.map((s: any) => s.unionId)));

echoHook!(sent("b", "u:echo-1"));
check("另一端发送时补偿记在它自己名下",
	(counts8().b ?? 0) === 1 && (counts8().a ?? 0) === (afterEcho.a ?? 0),
	JSON.stringify(counts8()));

acceptorModule.unload(ctx8);
(ctx8.kv as KVStore).close();

// 静默不丢受理人: 定时回收会把受理人一起丢掉, 下一条消息就由先到者当选 —— 这正是抖动
const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
const ctx6 = createCtx(new KVStore(path.join(dataDir, "quiet.db")), {
	dryRun: false,
	"window.windowMs": 1000,
});
acceptorModule.init(ctx6);
const exported6 = ctx6.exports as typeof exported;
const endpoint6 = uiRoutes.find(route => route.path === "acceptor_state")?.handler as
	((body: unknown) => any) | undefined;

runFilter(messageEvent(), bot, meta("a")); // a 当选
runFilter(messageEvent(), bot, meta("b")); // b 被拦, 但计入窗口
check("静默前已知两个适配器",
	(endpoint6!({ action: "state", botId: "bot-1" }).sessions[0]?.adapters ?? []).sort().join(",") === "a,b");

exported6.override("bot-1", "union-1", "b");
await wait(1300); // 比窗口(1s)长: 静默期满, 窗口已空

check("窗口静默后受理人不变", exported6.state("bot-1", "union-1")?.acceptor === "b",
	String(exported6.state("bot-1", "union-1")?.acceptor));
check("静默后原受理人的派发仍被拦", runFilter(messageEvent(), bot, meta("a")) === false);

const quietView = endpoint6!({ action: "state", botId: "bot-1" }).sessions[0];
check("静默后计数从 0 重新累积",
	(quietView?.counts?.a ?? 0) === 1 && (quietView?.counts?.b ?? 0) === 0,
	JSON.stringify(quietView?.counts));
check("静默后受理人仍留在页面上", quietView?.acceptor === "b");
check("静默后仍能列出可切换的适配器",
	(quietView?.adapters ?? []).join(",") === "a,b", JSON.stringify(quietView?.adapters));

// 静默后还能手工切回去: 窗口裁了, 但“见过哪些适配器”不该跟着丢
const switchBack = endpoint6!({ action: "override", botId: "bot-1", unionId: "union-1", adapter: "a" });
check("静默后仍可手工切回另一个适配器", switchBack.sessions[0]?.acceptor === "a",
	String(switchBack.sessions[0]?.acceptor));
exported6.override("bot-1", "union-1", "b");
runFilter(messageEvent(), bot, meta("a")); // 再给窗口塞一条, 下面好验证 flush 的静默分支

await wait(1300); // 再让窗口空一次
const beforeQuietFlush = logs.length;
acceptorModule.unload(ctx6); // unload 会跑一次 flush
const quietFlushLogs = logs.slice(beforeQuietFlush).join("\n");

// 正式模式不刷日志: 页面能看的东西不该每分钟再打一遍
check("正式模式 flush 不输出周期汇总", !quietFlushLogs.includes("[受理人]"), quietFlushLogs);
check("正式模式也不报静默会话", !quietFlushLogs.includes("无派发"), quietFlushLogs);
check("正式模式 flush 仍把状态落盘", (ctx6.kv as KVStore).count("acceptor:v1:") === 1,
	String((ctx6.kv as KVStore).count("acceptor:v1:")));
(ctx6.kv as KVStore).close();

// ---- @ 消息: 计数与判定照做, 但一律放行 ----
// 早先这里是提前 return, 结果 @ 消息连窗口都进不去, 快速通道的 fastStreak 永远是 0。
const ctx9 = createCtx(new KVStore(path.join(dataDir, "mention.db")), {
	dryRun: false,
	"fastPath.consecutive": 2,
	// 注意: `readParams` 对 silenceMs 用的是 positive(), 所以 0 会被回退成默认的
	// 15000 —— 这里用 1 毫秒, 再用真实的 `wait` 跨过它。
	"fastPath.silenceMs": 1,
});
acceptorModule.init(ctx9);

const exported9 = ctx9.exports as typeof exported;
const endpoint9 = uiRoutes.find(route => route.path === "acceptor_state")?.handler as
	((body: unknown) => any) | undefined;
const view9 = () => endpoint9!({ action: "state", botId: "bot-1" }).sessions[0];

const atMe = (from: string, sessionId = "u:mention-1") => runFilter(
	{ ...messageEvent(sessionId), mentionedSelf: true } as any,
	bot,
	meta(from),
);

runFilter(messageEvent("u:mention-1"), bot, meta("a")); // a 当选
check("@ 之前受理人是 a", exported9.state("bot-1", "mention-1")?.acceptor === "a");

await wait(10); // 让受理人“沉默”超过 silenceMs(1ms)
check("非受理人被 @ 时仍放行", atMe("b") === true);
check("@ 消息不进探针计数", (view9()?.counts?.b ?? 0) === 0, JSON.stringify(view9()?.counts));
check("@ 消息进 @ 计数", (view9()?.mentions?.b ?? 0) === 1, JSON.stringify(view9()?.mentions));
check("第一次 @ 只计数不转移", exported9.state("bot-1", "mention-1")?.acceptor === "a");
check("fastStreak 被记下来了", (exported9.state("bot-1", "mention-1")?.fastStreak ?? 0) === 1,
	String(exported9.state("bot-1", "mention-1")?.fastStreak));

check("第二次 @ 依然放行", atMe("b") === true);
check("@ 快速通道真的能转移",
	exported9.state("bot-1", "mention-1")?.acceptor === "b",
	String(exported9.state("bot-1", "mention-1")?.acceptor));

// 受理人自己被 @ 时照常放行, 并打断连击
check("受理人被 @ 时放行", atMe("b") === true);
check("受理人被 @ 不累积连击", (exported9.state("bot-1", "mention-1")?.fastStreak ?? 0) === 0,
	String(exported9.state("bot-1", "mention-1")?.fastStreak));

acceptorModule.unload(ctx9);
(ctx9.kv as KVStore).close();

// 演练模式才输出汇总 —— 那是关 dryRun 之前该看的东西
const ctx7 = createCtx(new KVStore(path.join(dataDir, "verbose.db")), { dryRun: true });
acceptorModule.init(ctx7);
runFilter(messageEvent(), bot, meta("a")); // a 当选
// 之后 a 不再有派发, b 持续活跃 → 差值跨过阈值, 累积证据直到转移
for (let i = 0; i < 8; i++) runFilter(messageEvent(), bot, meta("b"));
check("演练模式下也会发生转移",
	(ctx7.exports as typeof exported).state("bot-1", "union-1")?.acceptor === "b",
	String((ctx7.exports as typeof exported).state("bot-1", "union-1")?.acceptor));

const beforeVerboseFlush = logs.length;
acceptorModule.unload(ctx7);
const verboseLogs = logs.slice(beforeVerboseFlush).join("\n");
check("演练模式输出周期汇总", verboseLogs.includes("[受理人]"), verboseLogs);
check("汇总里不会出现“已回收”", !verboseLogs.includes("已回收"), verboseLogs);
(ctx7.kv as KVStore).close();

// 转移日志: 两种模式都记(低频事件), 但不可读的 NUL 分隔不能进日志
const transferLogs = logs.filter(line => line.includes("→"));
check("转移日志不含 NUL 分隔符", transferLogs.every(line => !line.includes("\u0000")),
	transferLogs.join("\n"));
check("转移日志带可读的 bot / union",
	transferLogs.some(line => /\[受理人\](\[演练\])? bot-\d+ \/ \S+ → \w+/.test(line)),
	transferLogs.join("\n"));
check("演练模式下的转移日志标了 [演练]",
	transferLogs.some(line => line.startsWith("[受理人][演练]")),
	transferLogs.join("\n"));
check("正式模式下的转移日志不标 [演练]",
	transferLogs.some(line => line.startsWith("[受理人] bot-")) || transferLogs.length === 0,
	transferLogs.join("\n"));

await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
