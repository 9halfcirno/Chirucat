import type { ServiceContext } from "../../src/plugin/services/context";
import type { ServiceModule } from "../../src/plugin/services/service";
import type { SessionType } from "../../src/protocols/session";
import { createAcceptorHandler } from "./api";
import { evaluate } from "./detector";
import type {
	AcceptorMember,
	AcceptorSessionView,
	AcceptorSnapshot,
	AcceptorState,
	DetectorParams,
} from "./types";
import { SlidingWindow } from "./window";

/**
 * Chirucat 受理人服务
 *
 * 让同一个逻辑会话(union)只由一个适配器响应。两个适配器被拉进同一个群并完成会话
 * 绑定后, 同一条消息会被两端各派发一次; 受理人机制保证**恰好一个**适配器把它交给
 * 业务层, 另一端只作为探针参与统计、不进入处理链。
 *
 * ## 为什么只数不清内容
 *
 * 平台给的东西不可全信: 同一条真实消息在两侧可以是卡片 vs 封面图、动画表情 vs
 * 占位文本, 甚至一侧完全没有内容。任何依赖内容比对的判定都会在真实数据上退化。
 * 派发量差值则是聚合量 —— 单条丢包、单条晚到会被滑动窗口摊平, 不会像逐条配对
 * 那样被一次错配污染。因此这里只保留"谁在这段时间里派发了多少条非 @ 消息"。
 *
 * ## 记录入口为什么在 filter 里
 *
 * 被拦下的事件不会再进入 `observe`。而"非受理人收到的消息"恰恰是探测的主要信号,
 * 所以采集点必须与拦截决策在同一位置: `filter` 里先记录与判定, 再返回结果。
 *
 * ## dryRun
 *
 * 默认开启: 完整跑判定(状态会像生产一样演进, 便于观察它"想"怎么切), 但不真的
 * 拦截任何事件。确认参数与行为都正常后再关掉。
 */

/** KV 键前缀 */
const KV_PREFIX = "acceptor:v1:";

const ALL_SESSION_TYPES: readonly SessionType[] = ["private", "group", "channel"];

/** 一个逻辑会话的运行态 */
type Runtime = {
	window: SlidingWindow;
	state: AcceptorState | null;
	/** 自上次汇总以来的统计 */
	stats: { messages: number; blocked: number; transfers: number };
};

/** 模块级状态: 服务插件进程内单例, init / unload 成对调用 */
let runtimes: Map<string, Runtime> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let kvAvailable = false;
/** 没有逻辑会话组的消息数: 这类消息无法跨适配器对齐, 一律放行 */
let noUnionCount = 0;

/**
 * 解析后的配置缓存
 *
 * 参数在每条消息上都要用, 而 `config.get` 是路径查找 —— 高速率下没必要把每条消息
 * 都拿去重新解析。用户改配置时由 `config.watch` 清掉, 下一条消息重新解析。
 */
let cached: { params: DetectorParams; sessionTypes: SessionType[] } | null = null;

/** 取当前生效的参数与会话类型(带缓存) */
function settings(ctx: ServiceContext): { params: DetectorParams; sessionTypes: SessionType[] } {
	if (!cached) cached = { params: readParams(ctx), sessionTypes: readSessionTypes(ctx) };
	return cached;
}

export default {
	init(ctx: ServiceContext) {
		const table = new Map<string, Runtime>();
		runtimes = table;
		noUnionCount = 0;
		cached = null;

		// 改配置后下一条消息重新解析参数(不需要重启服务)
		ctx.config.watch(() => { cached = null; });

		try {
			ctx.kv.init();
			restore(ctx, table);
			kvAvailable = true;
		} catch (e) {
			kvAvailable = false;
			ctx.logger.warn(`受理人状态将只保留在内存中: ${message(e)}`);
		}

		ctx.event.filter((event, bot, meta) => {
			if (runtimes !== table) return true; // 已卸载
			if (event.type !== "message.create") return true;
			if (ctx.config.get<boolean>("enabled", true) !== true) return true;
			if (!settings(ctx).sessionTypes.includes(event.sessionType)) return true;

			const unionId = resolveUnion(ctx, event.sessionId);
			if (!unionId) {
				// 没有共同标识就无法判断"另一端是不是同一个会话", 交给业务层去重
				noUnionCount++;
				return true;
			}

			const key = keyOf(bot.id, unionId);
			const runtime = table.get(key) ?? createRuntime();
			table.set(key, runtime);

			try {
				return dispatch(ctx, runtime, key, event.mentionedSelf ?? null, meta.adapter);
			} catch (e) {
				// 判定出错时放行: 宁可重复响应, 也不能让消息凭空消失
				ctx.logger.error(`受理人判定失败, 本次放行: ${message(e)}`);
				return true;
			}
		});

		timer = setInterval(() => flush(ctx), readFlushInterval(ctx));
		(timer as unknown as { unref?: () => void }).unref?.();

		ctx.exports = {
			/** 某个逻辑会话的受理人与窗口计数 */
			state: (botId: string, unionId: string): AcceptorState | null =>
				runtimes?.get(keyOf(botId, unionId))?.state ?? null,
			/** 全部逻辑会话的受理人快照 */
			all: (): Record<string, AcceptorState | null> => {
				const out: Record<string, AcceptorState | null> = {};
				for (const [key, runtime] of runtimes ?? []) out[key] = runtime.state;
				return out;
			},
			/** 某个 Bot 的完整视图(WebUI 页面用) */
			snapshot: (botId: string): AcceptorSnapshot => readSnapshot(ctx, botId),
			/** 手工指定受理人(排障用): 不经过判定, 直接换人并清空证据 */
			override: (botId: string, unionId: string, adapter: string, at = Date.now()): void =>
				overrideAcceptor(ctx, botId, unionId, adapter, at),
			/** 只清一个逻辑会话, 不动同一个 Bot 的其它会话 */
			resetSession: (botId: string, unionId: string): void => resetSession(ctx, botId, unionId),
			/** 清空全部状态与计数 */
			reset: (): void => {
				runtimes?.clear();
				if (!kvAvailable) return;
				try {
					ctx.kv.clearPrefix(KV_PREFIX);
				} catch (e) {
					ctx.logger.warn(`清理落盘的受理人状态失败: ${message(e)}`);
				}
			},
		};

		// WebUI: 端点在 /service/chirucat-acceptor/api/acceptor_state,
		// 页面进 Bot 详情窗口(适配器是 Bot 级的, 没必要占一级导航)。
		// 未启用 WebUI 时 ctx.core.webui 为 null, 服务本身照常工作。
		ctx.core.webui?.register({
			path: "acceptor_state",
			method: "POST",
			auth: true,
			handler: createAcceptorHandler({
				snapshot: (botId) => readSnapshot(ctx, botId),
				override: (botId, unionId, adapter) => overrideAcceptor(ctx, botId, unionId, adapter),
				resetSession: (botId, unionId) => resetSession(ctx, botId, unionId),
			}),
		});

		ctx.core.webui?.bot.pages.register({
			id: "acceptor",
			title: "受理人",
			icon: "acceptor.svg",
			module: "bot.js",
			styles: ["acceptor.css"],
			order: 40,
		});

		ctx.logger.log(
			`受理人服务已启动 (${ctx.config.get<boolean>("dryRun", true) ? "dry-run: 只判定不拦截" : "正式模式: 每个会话只放行受理人"})`,
		);
	},

	unload(ctx?: ServiceContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (ctx) flush(ctx);
		runtimes = null;
		cached = null;
	},
} as ServiceModule;

/* -------------------- 单次派发 -------------------- */

/**
 * 记录一条事件并给出放行结果
 *
 * 窗口计数与判定是同一次调用的前后两步: 先把这条事件记进窗口, 再用**包含它**的
 * 计数做判定。否则刚到的消息要等下一次事件才能被算进去, 首次选举之外的低速率
 * 场景会漏掉一半证据。
 */
function dispatch(
	ctx: ServiceContext,
	runtime: Runtime,
	key: string,
	mentionedSelf: boolean | null,
	adapter: string,
): boolean {
	const at = Date.now();
	const params = settings(ctx).params;

	runtime.window.record(adapter, at, mentionedSelf);
	runtime.stats.messages++;

	const decision = evaluate(params, {
		at,
		adapter,
		mentionedSelf,
		counts: runtime.window.counts(at, params.windowMs),
		lastProbeAt: runtime.window.lastProbeAt(),
		state: runtime.state,
	});

	runtime.state = decision.state;

	if (decision.transferred) {
		runtime.stats.transfers++;
		// 只在换人时立即落盘: 每条消息都写一次库没必要, 其余状态由 flush 周期写入
		persist(ctx, key, decision.state);
		ctx.logger.log(`[受理人] ${key} → ${decision.state.acceptor} (${decision.reason})`);
	}

	if (ctx.config.get<boolean>("dryRun", true) === true) return true;

	if (!decision.allow) runtime.stats.blocked++;
	return decision.allow;
}

function createRuntime(): Runtime {
	return {
		window: new SlidingWindow(),
		state: null,
		stats: { messages: 0, blocked: 0, transfers: 0 },
	};
}

function keyOf(botId: string, unionId: string): string {
	return `${botId}\u0000${unionId}`;
}

/** 这个会话里出现过的适配器: 计数、@ 计数、最近派发与当前受理人的并集 */
function knownAdapters(runtime: Runtime, windowMs: number, at: number): string[] {
	const set = new Set<string>();
	for (const source of [
		runtime.window.counts(at, windowMs),
		runtime.window.mentions(at, windowMs),
		runtime.window.lastProbeAt(),
	]) {
		for (const adapter of Object.keys(source)) set.add(adapter);
	}
	if (runtime.state?.acceptor) set.add(runtime.state.acceptor);
	return [...set].sort();
}

/**
 * 手工指定受理人
 *
 * 适配器必须是这个会话里出现过的: 设成一个不存在的名字, 只会让这个会话永久没人
 * 放行, 排查起来还看不出原因。会话从未派发过(没有任何计数)时不校验 —— 此时没有
 * 可参照的名单, 由调用方负责。
 */
function overrideAcceptor(
	ctx: ServiceContext,
	botId: string,
	unionId: string,
	adapter: string,
	at = Date.now(),
): void {
	const key = keyOf(botId, unionId);
	const existing = runtimes?.get(key);

	if (existing) {
		const known = knownAdapters(existing, settings(ctx).params.windowMs, at);
		if (known.length > 0 && !known.includes(adapter)) {
			throw { err: `适配器 ${adapter} 未在此会话出现过(已知: ${known.join(", ")})`, code: 400 };
		}
	}

	const runtime = existing ?? createRuntime();
	runtimes?.set(key, runtime);
	runtime.state = {
		acceptor: adapter,
		since: at,
		scores: {},
		fastStreak: 0,
		cooldownUntil: 0,
		transfers: 0,
	};
	persist(ctx, key, runtime.state);
}

/** 清掉一个逻辑会话的运行态与落盘记录; 其它会话不受影响 */
function resetSession(ctx: ServiceContext, botId: string, unionId: string): void {
	const key = keyOf(botId, unionId);

	const runtime = runtimes?.get(key);
	if (runtime) {
		runtime.window.clear();
		runtime.state = null;
		runtime.stats = { messages: 0, blocked: 0, transfers: 0 };
		runtimes?.delete(key);
	}

	if (!kvAvailable) return;
	try {
		ctx.kv.delete(KV_PREFIX + key);
	} catch (e) {
		ctx.logger.warn(`清理会话 ${short(unionId)} 的落盘状态失败: ${message(e)}`);
	}
}

/* -------------------- WebUI 快照 -------------------- */

/** 一个逻辑会话的成员列表; 会话表不可用时给出空数组, 不让页面整个打不开 */
function membersOf(ctx: ServiceContext, unionId: string): AcceptorMember[] {
	try {
		return ctx.core.session.listMembers(unionId).map(member => ({
			platform: member.platform,
			type: member.type,
			id: member.id,
		}));
	} catch {
		return [];
	}
}

/** 生成某个 Bot 的完整视图 */
function readSnapshot(ctx: ServiceContext, botId: string): AcceptorSnapshot {
	const at = Date.now();
	const { params } = settings(ctx);
	const sessions: AcceptorSessionView[] = [];

	for (const [key, runtime] of runtimes ?? []) {
		const owner = splitKey(key);
		if (owner.botId !== botId) continue;

		const state = runtime.state;
		const counts = runtime.window.counts(at, params.windowMs);
		const mentions = runtime.window.mentions(at, params.windowMs);

		sessions.push({
			unionId: owner.unionId,
			acceptor: state?.acceptor ?? null,
			since: state?.since ?? null,
			transfers: state?.transfers ?? 0,
			cooldownRemainingMs: Math.max(0, (state?.cooldownUntil ?? 0) - at),
			fastStreak: state?.fastStreak ?? 0,
			scores: state?.scores ?? {},
			counts,
			mentions,
			lastProbeAt: runtime.window.lastProbeAt(),
			adapters: knownAdapters(runtime, params.windowMs, at),
			members: membersOf(ctx, owner.unionId),
		});
	}

	// 最近活跃的排前面: 排障时第一个要看的就是刚出问题的那个群
	sessions.sort((a, b) => lastActiveOf(b) - lastActiveOf(a) || a.unionId.localeCompare(b.unionId));

	return {
		enabled: ctx.config.get<boolean>("enabled", true) === true,
		dryRun: ctx.config.get<boolean>("dryRun", true) === true,
		now: at,
		windowMs: params.windowMs,
		thresholds: {
			minSamples: params.minSamples,
			transferThreshold: params.transferThreshold,
			switchBackThreshold: params.switchBackThreshold,
			cooldownMs: params.cooldownMs,
			relativeGap: params.relativeGap,
			minAbsoluteGap: params.minAbsoluteGap,
			absoluteGap: params.absoluteGap,
		},
		fastPath: {
			enabled: params.fastPath.enabled,
			consecutive: params.fastPath.consecutive,
			silenceMs: params.fastPath.silenceMs,
		},
		sessions,
	};
}

/** 视图侧的最近活跃时刻(与 lastActiveAt 同口径, 但作用在投影上) */
function lastActiveOf(view: AcceptorSessionView): number {
	let last = view.since ?? 0;
	for (const at of Object.values(view.lastProbeAt)) {
		if (at > last) last = at;
	}
	return last;
}

/** 只读查逻辑会话组; Core 正在释放时按"没有 union"处理, 不让判定拖垮消息链 */
function resolveUnion(ctx: ServiceContext, sessionId: string): string | null {
	try {
		return ctx.core.session.unionOf(sessionId);
	} catch {
		return null;
	}
}

/* -------------------- 配置 -------------------- */

function readSessionTypes(ctx: ServiceContext): SessionType[] {
	const raw = ctx.config.get<unknown>("sessionTypes", ["group"]);
	if (!Array.isArray(raw)) return ["group"];

	// 空数组是用户的有意选择(不观察任何会话), 不替他回退到默认值
	return raw.filter((type): type is SessionType =>
		typeof type === "string" && ALL_SESSION_TYPES.includes(type as SessionType));
}

/**
 * 从配置读判定参数
 *
 * 导出来只为让自检脚本能验证**配置路径**与 schema 一致 —— WebUI 的 group 控件会把
 * 子控件的值嵌在组名下, 路径写错就会静默地一直用默认值。
 */
export function readParams(ctx: Pick<ServiceContext, "config">): DetectorParams {
	return {
		windowMs: positive(ctx.config.get("window.windowMs", 60000), 60000),
		minSamples: positive(ctx.config.get("thresholds.minSamples", 5), 5),
		silenceThreshold: nonNegative(ctx.config.get("thresholds.silenceThreshold", 0), 0),
		relativeGap: positive(ctx.config.get("thresholds.relativeGap", 0.5), 0.5),
		minAbsoluteGap: positive(ctx.config.get("thresholds.minAbsoluteGap", 3), 3),
		absoluteGap: positive(ctx.config.get("thresholds.absoluteGap", 5), 5),
		transferThreshold: positive(ctx.config.get("thresholds.transferThreshold", 2), 2),
		switchBackThreshold: positive(ctx.config.get("thresholds.switchBackThreshold", 4), 4),
		cooldownMs: nonNegative(ctx.config.get("thresholds.cooldownMs", 300000), 300000),
		fastPath: {
			enabled: ctx.config.get<boolean>("fastPath.enabled", true) === true,
			consecutive: positive(ctx.config.get("fastPath.consecutive", 2), 2),
			silenceMs: positive(ctx.config.get("fastPath.silenceMs", 15000), 15000),
		},
	};
}

function readFlushInterval(ctx: ServiceContext): number {
	return positive(ctx.config.get("window.flushIntervalMs", 60000), 60000);
}

/** 配置里被改成 0/负数/非数字时退回默认值, 而不是按 0 毫秒窗口跑 */
function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 允许为 0 的配置项(沉默阈值、冷却期) */
function nonNegative(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/* -------------------- 持久化与汇总 -------------------- */

/** 一次汇总里最多展开多少个会话 */
const MAX_REPORTED = 20;

/** 把状态写入 KV(单条写, 键有上限, 不需要批量事务) */
function persist(ctx: ServiceContext, key: string, state: AcceptorState): void {
	if (!kvAvailable) return;
	try {
		ctx.kv.set(KV_PREFIX + key, state);
	} catch (e) {
		kvAvailable = false;
		ctx.logger.warn(`受理人状态落盘失败, 后续只保留在内存中: ${message(e)}`);
	}
}

/** 输出本轮汇总, 并回收彻底空掉的窗口 */
function flush(ctx: ServiceContext): void {
	const table = runtimes;
	if (!table) return;

	const at = Date.now();
	const windowMs = settings(ctx).params.windowMs;
	const lines: string[] = [];

	for (const [key, runtime] of [...table]) {
		const { botId, unionId } = splitKey(key);

		if (!runtime.window.prune(at, windowMs)) {
			// 窗口内已经没有任何派发: 清掉运行态, 避免长期运行后无限堆积
			table.delete(key);
			lines.push(`  ${botId} / ${short(unionId)}  窗口内无派发, 已回收`);
			continue;
		}

		const counts = runtime.window.counts(at, windowMs);
		const mentions = runtime.window.mentions(at, windowMs);
		const detail = Object.keys({ ...counts, ...mentions })
			.sort()
			.map(adapter => `${adapter}: ${counts[adapter] ?? 0}(@${mentions[adapter] ?? 0})`)
			.join(" | ");

		const state = runtime.state;
		const stats = runtime.stats;
		const statsText = `消息${stats.messages} 拦截${stats.blocked} 转移${stats.transfers}`;

		lines.push(
			`  ${botId} / ${short(unionId)}  受理人=${state?.acceptor ?? "(未选举)"}  ${detail || "(无计数)"}  ${statsText}`,
		);

		// 累计证据也要跟着落盘, 否则重启后每条都要重新攒
		if (state) persist(ctx, key, state);

		runtime.stats = { messages: 0, blocked: 0, transfers: 0 };
	}

	if (noUnionCount > 0) {
		lines.push(`  另有 ${noUnionCount} 条消息没有逻辑会话组, 未参与判定`);
		noUnionCount = 0;
	}

	if (lines.length === 0) return;

	const shown = lines.slice(0, MAX_REPORTED);
	const hidden = lines.length - shown.length;
	const more = hidden > 0 ? `\n  …另有 ${hidden} 个会话未展开` : "";

	ctx.logger.log(`[受理人] ${table.size} 个逻辑会话\n${shown.join("\n")}${more}`);
}

function splitKey(key: string): { botId: string; unionId: string } {
	const separator = key.indexOf("\u0000");
	return separator < 0
		? { botId: key, unionId: "" }
		: { botId: key.slice(0, separator), unionId: key.slice(separator + 1) };
}

function short(id: string): string {
	return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** 从 KV 恢复上次的受理人; 脏数据跳过, 不让一条坏记录挡住整个服务 */
function restore(ctx: ServiceContext, table: Map<string, Runtime>): void {
	let entries: Array<[string, unknown]>;
	try {
		entries = ctx.kv.list<unknown>(KV_PREFIX);
	} catch (e) {
		ctx.logger.warn(`读取受理人状态失败: ${message(e)}`);
		return;
	}

	let restored = 0;
	for (const [key, value] of entries) {
		if (!isAcceptorState(value)) continue;

		const runtime = table.get(key.slice(KV_PREFIX.length)) ?? createRuntime();
		runtime.state = value;
		table.set(key.slice(KV_PREFIX.length), runtime);
		restored++;
	}

	if (restored) ctx.logger.log(`已恢复 ${restored} 个逻辑会话的受理人`);
}

/** 宽松校验持久化下来的状态形状: 结构不符就整条丢弃 */
function isAcceptorState(value: unknown): value is AcceptorState {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<AcceptorState>;

	return typeof v.acceptor === "string"
		&& typeof v.since === "number"
		&& typeof v.fastStreak === "number"
		&& typeof v.cooldownUntil === "number"
		&& typeof v.transfers === "number"
		&& !!v.scores && typeof v.scores === "object";
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
