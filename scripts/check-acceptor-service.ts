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
}

{
	const w = new SlidingWindow();
	w.record("a", 1000, false);
	check("窗口内还有数据时 prune 返回 true", w.prune(2000, 60000) === true);
	check("窗口空了 prune 返回 false", w.prune(600000, 60000) === false);
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

/** 假上下文: 只实现本服务用到的那几项 */
function createCtx(kv: KVStore, settings: Record<string, unknown> = {}) {
	uiRoutes = [];
	uiPages = [];

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

await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
