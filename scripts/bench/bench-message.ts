/**
 * 消息链路压力测试台
 *
 * 目的: 在不联网、不碰真实 Bot 数据的前提下, 测出框架消息处理链的吞吐上限,
 * 以及各装配层(核心链 / 统计 / 服务插件 / Bot 插件 / 日志 / 身份落账)的开销占比。
 *
 * 与真实运行的差别(读报告时要记住):
 * - 事件由压测台直接喂给 `Bot.dispatch`, 即适配器收到平台数据之后的那一步;
 *   网络收包、反序列化与适配器自己的逻辑不在口径内。
 * - SQLite 用 `data/bench/<场景>-<随机>/` 下的独立库, 全部场景跑完再删, 真实库与 bots/ 不碰。
 * - 发送侧只走到适配器 handler, 不回平台。
 *
 * 用法:
 *   npx tsx scripts/bench/bench-message.ts [选项]
 *     --scenarios=core,stats,typical,quiet,identity,fresh,async,burst  要跑的场景
 *     --ladder=10,25,50,100,200,400,800,1600,3200                      速率阶梯(msg/s)
 *     --step=6        每档采样时长(秒)
 *     --warmup=1.5    每档预热时长(秒, 不计入统计)
 *     --gap=0.4       档间间歇(秒)
 *     --burst=2       burst 场景的饱和采样时长(秒)
 *     --quick         只跑 typical 的前三档, 用于装配自检
 *     --probe         不跑阶梯, 只按窗口量静置 CPU(查"零消息也烧 CPU"用)
 *     --probe-rounds=3    probe: 装拆几次
 *     --probe-windows=3   probe: 每次装好后连续量几个窗口
 *     --probe-window=4    probe: 每个窗口时长(秒)
 *     --leak-check      不跑阶梯, 只做监听泄漏体检: 释放后立刻删沙盒目录再静置
 *     --cpu-prof=DIR  为每个场景记一份 CPU profile(只覆盖采样窗口, 不含装配), 存到 DIR/<场景>.cpuprofile
 *     --out=PATH      结果 JSON 路径
 *
 * 熔断: 任一档位出现跟不上目标速率、尾延迟超标、事件循环卡死、进程内存超阈、
 * 整机 CPU 超阈或在途 handler 失控, 该场景立即停止继续加压 —— 阶梯是往上加的,
 * 不收手会把机器拖死。
 *
 * 输出: 进度与表格走 stderr(stdout 会被框架自己的每消息日志占满, 由调用方丢弃),
 * 每跑完一个场景把结果写一次盘。
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import inspector from "node:inspector";
import os from "node:os";
import { performance, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import sqlite from "better-sqlite3";

import { Core } from "../../src/core";
import { Bot } from "../../src/bot/bot";
import { UserManager } from "../../src/internal/user-manager";
import { SessionManager } from "../../src/internal/session-manager";
import { UserProfileManager } from "../../src/internal/user-profile";
import { StatisticsManager } from "../../src/statistics/manager";
import { setLogLevel } from "../../src/utils/logger";
import { root } from "../../src/utils/root";
import type { MessageCreateEvent } from "../../src/protocols/event/message";

/* ────────────────────────────── 参数 ────────────────────────────── */

type Options = {
	scenarios: string[];
	ladder: number[];
	stepMs: number;
	warmupMs: number;
	gapMs: number;
	burstMs: number;
	out: string;
	/** 只量静置: 装配 -> 静置 -> 灌一轮 -> 再静置, 不跑阶梯。用来定位"空转也在耗 CPU" */
	probe: boolean;
	probeRounds: number;
	probeWindows: number;
	probeWindowMs: number;
	/** 释放体检: 按正常顺序拆解设施后立刻删沙盒目录, 再静置 —— 用来确认框架有没有该关没关的监听 */
	leakCheck: boolean;
	/** 记 CPU profile 的目录(每个场景一份 <场景id>.cpuprofile); 只覆盖采样窗口, 不给就不记 */
	cpuProf: string | null;
};

function parseArgs(argv: string[]): Options {
	const pick = (name: string): string | undefined => {
		const hit = argv.find(a => a.startsWith(`--${name}=`));
		return hit ? hit.slice(name.length + 3) : undefined;
	};
	const num = (name: string, defMs: number): number => {
		const raw = pick(name);
		// 命令行按秒给(--step=6), 默认值直接按毫秒写
		return raw === undefined ? defMs : Number(raw) * 1000;
	};

	const quick = argv.includes("--quick");
	const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-").slice(0, 19);

	return {
		scenarios: (pick("scenarios") ?? (quick ? "typical" : "core,stats,typical,quiet,identity,fresh,async,burst"))
			.split(",").map(s => s.trim()).filter(Boolean),
		ladder: (pick("ladder") ?? (quick ? "10,50,100" : "10,25,50,100,200,400,800,1600,3200"))
			.split(",").map(Number).filter(n => n > 0),
		stepMs: num("step", quick ? 1500 : 6000),
		warmupMs: num("warmup", quick ? 300 : 1500),
		gapMs: num("gap", 400),
		burstMs: num("burst", 2000),
		out: pick("out") ?? path.join(root, "data", "bench", `results-${stamp}.json`),
		probe: argv.includes("--probe"),
		probeRounds: Number(pick("probe-rounds") ?? 3),
		probeWindows: Number(pick("probe-windows") ?? 3),
		probeWindowMs: num("probe-window", 4000),
		leakCheck: argv.includes("--leak-check"),
		cpuProf: (() => {
			const raw = pick("cpu-prof");
			return raw === undefined ? null : path.resolve(root, raw);
		})(),
	};
}

const opt = parseArgs(process.argv.slice(2));

function say(line = ""): void {
	process.stderr.write(line + "\n");
}

const coreCount = os.cpus().length || 1;

/** 开局测到的整机噪声(本进程静置时的整机占用%), 用于给"整机 CPU"定性 */
let envSystemPercent: number | null = null;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/* ────────────────────────────── 场景 ────────────────────────────── */

type Traffic = {
	/** 命中指令(走 CommandManager, 命中后不再进插件消息回调)的占比 */
	commandRatio: number;
	/** 触发插件回复(走 message.send -> 适配器 Action)的占比 */
	replyRatio: number;
	/** 触发异步 handler(await 10ms)的占比 */
	asyncRatio: number;
	/** 派发前做账号/会话落账(ctx.user.get / ctx.session.get), 贴近真实适配器 */
	identity: boolean;
	/** 每条消息换一个全新用户与会话(账号/会话表持续增行) */
	fresh: boolean;
};

type ScenarioConfig = {
	id: string;
	label: string;
	statistics: boolean;
	plugins: string[];
	services: string[];
	logLevel: "debug" | "info" | "warn";
	mode: "ramp" | "burst";
	traffic: Traffic;
	note: string;
};

const ADAPTER = "bench-adapter";
const BOT_PLUGINS = [ADAPTER, "bench-echo", "bench-reply", "bench-command"];

const PLAIN: Traffic = { commandRatio: 0, replyRatio: 0, asyncRatio: 0, identity: false, fresh: false };
const TYPICAL: Traffic = { commandRatio: 0.2, replyRatio: 0.2, asyncRatio: 0, identity: false, fresh: false };

const SCENARIOS: ScenarioConfig[] = [
	{
		id: "core", label: "纯核心链", note: "适配器派发 -> 实体构造 -> 消息处理链, 无统计、无服务插件、无业务插件",
		statistics: false, plugins: [ADAPTER], services: [], logLevel: "info", mode: "ramp", traffic: PLAIN,
	},
	{
		id: "stats", label: "核心 + 统计", note: "在纯核心链之上打开统计模块(内存缓冲 + 批量落盘)",
		statistics: true, plugins: [ADAPTER], services: [], logLevel: "info", mode: "ramp", traffic: PLAIN,
	},
	{
		id: "typical", label: "典型装配", note: "统计 + 真实 permission 服务 + 3 个业务插件; 20% 命中指令、20% 触发回复",
		statistics: true, plugins: BOT_PLUGINS, services: ["chirucat-permission"], logLevel: "info", mode: "ramp", traffic: TYPICAL,
	},
	{
		id: "quiet", label: "典型装配(日志 warn)", note: "与 typical 同一套装配, 只把日志级别调到 warn —— 两者之差即每消息日志开销",
		statistics: true, plugins: BOT_PLUGINS, services: ["chirucat-permission"], logLevel: "warn", mode: "ramp", traffic: TYPICAL,
	},
	{
		id: "identity", label: "典型装配 + 身份落账", note: "派发前先 user.get/session.get(200 用户 / 20 会话的热库), 模拟真实群聊",
		statistics: true, plugins: BOT_PLUGINS, services: ["chirucat-permission"], logLevel: "info", mode: "ramp",
		traffic: { ...TYPICAL, identity: true },
	},
	{
		id: "fresh", label: "典型装配 + 全新用户", note: "每条消息一个新用户 + 新会话, 账号/会话表持续插入(写放大场景)",
		statistics: true, plugins: BOT_PLUGINS, services: ["chirucat-permission"], logLevel: "info", mode: "ramp",
		traffic: { ...TYPICAL, identity: true, fresh: true },
	},
	{
		id: "async", label: "典型装配 + 慢 handler", note: "15% 消息进一个 await 10ms 的 handler, 观察在途请求有无上界",
		statistics: true, plugins: [...BOT_PLUGINS, "bench-async"], services: ["chirucat-permission"], logLevel: "info", mode: "ramp",
		traffic: { ...TYPICAL, asyncRatio: 0.15 },
	},
	{
		id: "burst", label: "饱和吞吐(burst)", note: "不设速率, 采样窗口内连续派发, 测单进程吞吐天花板",
		statistics: true, plugins: BOT_PLUGINS, services: ["chirucat-permission"], logLevel: "info", mode: "burst", traffic: TYPICAL,
	},
];

/* ────────────────────────────── 夹具插件 ────────────────────────────── */

/**
 * 夹具插件不引用框架源码(跨目录导入会被插件加载器当外部依赖), 所以写成弱类型 TS;
 * 与压测台的通信走 globalThis 上的 __benchSink。
 */
const FIXTURES: Record<string, { type?: string; main: string }> = {
	"bench-adapter": {
		type: "adapter",
		main: `let seq = 0;
export default {
	init(ctx) {
		ctx.bot.onAction(async (action, extra) => {
			const G = globalThis;
			const sink = G.__benchSink;
			const t0 = extra ? extra.__t0 : undefined;
			if (sink && typeof t0 === "number") sink("e2e", performance.now() - t0);
			if (sink) sink("action");
			if (action.type === "message.send") return { success: true, id: "ack-" + (++seq) };
			if (action.type === "message.delete") return { success: true };
			return { success: false, error: "bench-adapter 不支持该动作" };
		});
	},
};`,
	},
	"bench-echo": {
		main: `export default {
	init(ctx) {
		// 三个通常不命中的匹配器: 复刻真实插件"注册了一堆回调、多数消息空跑一遍匹配"的形态
		ctx.message.start("/hi", () => {});
		ctx.message.includes("签到", () => {});
		ctx.message.regex(/^\\d{4}-\\d{2}-\\d{2}$/, () => {});
	},
};`,
	},
	"bench-reply": {
		main: `export default {
	init(ctx) {
		ctx.message.includes("bench", (msg) => { msg.reply("pong"); });
	},
};`,
	},
	"bench-command": {
		main: `export default {
	init(ctx) {
		ctx.command.register("bench", (msg) => { if (msg) msg.reply("pong-command"); });
	},
};`,
	},
	"bench-async": {
		main: `const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export default {
	init(ctx) {
		ctx.message.start("async", async (msg) => {
			const G = globalThis;
			if (G.__benchSink) G.__benchSink("in");
			await sleep(10);
			msg.reply("async-pong");
			if (G.__benchSink) G.__benchSink("out");
		});
	},
};`,
	},
};

/* ────────────────────────────── 被测环境 ────────────────────────────── */

const BOT_ID = "bench-bot";
const META = { adapter: ADAPTER, bot: BOT_ID };

type Rig = {
	core: Core;
	bot: Bot;
	db: sqlite.Database;
	dir: string;
	closed: boolean;
};

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value, null, "\t"), "utf8");
}

async function writeFixtures(pluginsDir: string): Promise<void> {
	for (const [id, fixture] of Object.entries(FIXTURES)) {
		const dir = path.join(pluginsDir, id);
		await fs.mkdir(dir, { recursive: true });
		await writeJson(path.join(dir, "manifest.json"), {
			id,
			version: "0.0.0",
			name: id,
			author: "bench",
			...(fixture.type ? { type: fixture.type } : {}),
			main: "index.ts",
		});
		await fs.writeFile(path.join(dir, "index.ts"), fixture.main, "utf8");
	}
}

/**
 * 手工装配一条消息链所需的设施
 *
 * 不调 Core.init(): 它会扫 bots/ 并按 state.json 拉起真实 Bot(含联网适配器)。
 * 这里按 init 的顺序装配同一批设施, 只把路径换成沙盒 —— 统计/服务插件/Bot 插件
 * 走的都是真实代码路径, 差别只在数据落在临时目录。
 */
async function buildRig(cfg: ScenarioConfig, dir: string): Promise<Rig> {
	const botDir = path.join(dir, "bots", BOT_ID);
	await writeFixtures(path.join(botDir, "plugins"));
	await writeJson(path.join(botDir, "config.json"), { id: BOT_ID, name: "压测 Bot" });
	await writeJson(path.join(botDir, "state.json"), { enable: true, enabledPlugins: cfg.plugins });

	const core = new Core({ webui: false, statistics: false, servicesStateFile: path.join(dir, "services-state.json") });
	await core.initSettings();
	setLogLevel(cfg.logLevel);

	const db = new sqlite(path.join(dir, "internal.db"));
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");

	core.user = new UserManager(db);
	core.session = new SessionManager(db);
	core.profile = new UserProfileManager(db);
	core.user.init();
	core.session.init();
	core.profile.init();

	if (cfg.statistics) {
		// 参数取 configs/statistics.json 的默认值
		core.statistics = new StatisticsManager(path.join(dir, "statistics.db"), {
			flushIntervalMs: 5000,
			bufferSize: 500,
			detailRetentionDays: 7,
			hourlyRetentionDays: 30,
		});
	}

	await core.services.scan(path.join(root, "services"));
	const failed = await core.services.syncState(cfg.services);
	if (failed.length) throw new Error(`服务插件起不来: ${failed.join(",")}`);

	const bot = new Bot({ id: BOT_ID, name: "压测 Bot", path: botDir } as any, core);
	await bot.initState();
	await bot.start();
	if (!bot.running) throw new Error("沙盒 Bot 未能启动");

	return { core, bot, db, dir, closed: false };
}

async function teardownRig(rig: Rig): Promise<void> {
	if (rig.closed) return;
	rig.closed = true;
	// 沙盒 Bot 是手工 new 出来的, 不在 BotManager 的名下, core.close() 不会替它收尾:
	// 它的 state.json / config.json 目录监听会一直开着。先按正常顺序释放它。
	await rig.bot.dispose();
	await rig.core.close();
	try {
		rig.db.close();
	} catch { /* 已关闭 */ }
	// 沙盒目录留到全部场景跑完再删。Windows 上"目录监听还开着、目录被删"会让进程
	// 永久烧掉一个核(隔离复现过), 而 core.close() 之后是否还有监听在, 只能靠
	// "删目录后还烧不烧"判定(见 leakCheck)—— 没必要拿后面的场景去赌。
	// 中途删目录等于给后面每个场景都偷走一个核, 数字就全废了。
	pendingSandboxes.push(rig.dir);
}

/** 待删沙盒: 见 teardownRig, 收尾统一清 */
const pendingSandboxes: string[] = [];

async function cleanSandboxes(): Promise<void> {
	const leftover: string[] = [];
	for (const dir of pendingSandboxes.splice(0)) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			// 监听句柄可能还攥着目录, 删不掉就留在 data/bench 下由人处理
			leftover.push(dir);
		}
	}
	if (leftover.length) say(`沙盒未能删除(仍被监听句柄占用): ${leftover.join(", ")}`);
}

/* ────────────────────────────── 流量发生 ────────────────────────────── */

class TrafficSource {
	private seq = 0;
	private users: string[] = [];
	private sessions: string[] = [];

	constructor(readonly cfg: ScenarioConfig, private readonly rig: Rig) { }

	/** 预热身份池: 真实群里绝大多数消息来自已存在的用户与会话 */
	prime(): void {
		const t = this.cfg.traffic;
		if (!t.identity && !t.fresh) return;
		for (let i = 0; i < 200; i++) this.users.push(this.rig.core.user!.get("bench", `u${i}`));
		for (let i = 0; i < 20; i++) this.sessions.push(this.rig.core.session!.get("bench", "group", `g${i}`));
	}

	next(): MessageCreateEvent {
		const i = this.seq++;
		const t = this.cfg.traffic;

		const text = i % 97 === 0
			// 掺入长消息, 避免全部命中同一个短字符串优化路径
			? `msg ${i} ` + "这条消息比一般的聊天消息长一些, 用来测试内容长度对处理链的影响。".repeat(4)
			: pickText(i, t);

		let senderId: string;
		let sessionId: string;
		if (t.fresh) {
			senderId = this.rig.core.user!.get("bench", `fresh-u${i}`);
			sessionId = this.rig.core.session!.get("bench", "group", `fresh-g${i}`);
		} else if (t.identity) {
			senderId = this.users[i % this.users.length] ?? "";
			sessionId = this.sessions[i % this.sessions.length] ?? "";
		} else {
			senderId = `u${i % 200}`;
			sessionId = `g${i % 20}`;
		}

		return {
			type: "message.create",
			time: Date.now(),
			platform: "bench",
			messageId: `m${i}`,
			quoteToken: `q${i}`,
			senderId,
			senderName: `压测用户${i % 200}`,
			sessionType: "group",
			sessionId,
			text,
			richContent: [{ type: "text", text }],
			extra: { __t0: performance.now() },
		};
	}
}

function pickText(i: number, t: Traffic): string {
	const roll = Math.random();
	if (t.asyncRatio > 0 && roll < t.asyncRatio) return `async ${i} 一条需要等待外部接口的消息`;
	if (roll < t.asyncRatio + t.commandRatio) return `/bench ${i} 参数`;
	if (roll < t.asyncRatio + t.commandRatio + t.replyRatio) return `msg ${i} bench 触发插件回复`;
	return `msg ${i} 一条不会命中任何业务逻辑的普通聊天消息`;
}

/* ────────────────────────────── 指标 ────────────────────────────── */

type Stats = { n: number; mean: number; p50: number; p95: number; p99: number; max: number };

function summarize(samples: number[]): Stats {
	if (!samples.length) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
	const sorted = Float64Array.from(samples).sort();
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
	let sum = 0;
	for (const v of sorted) sum += v;
	return { n: sorted.length, mean: sum / sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] ?? 0 };
}

/** 夹具插件回报: Action 数、端到端延迟样本、异步 handler 进出 */
class Sink {
	e2e: number[] = [];
	actions = 0;
	in = 0;
	out = 0;

	install(): void {
		(globalThis as Record<string, unknown>).__benchSink = (kind: string, value?: number) => {
			if (kind === "e2e" && typeof value === "number") this.e2e.push(value);
			else if (kind === "action") this.actions++;
			else if (kind === "in") this.in++;
			else if (kind === "out") this.out++;
		};
	}

	uninstall(): void {
		(globalThis as Record<string, unknown>).__benchSink = undefined;
	}

	reset(): void {
		this.e2e = [];
		this.actions = 0;
		this.in = 0;
		this.out = 0;
	}

	get pending(): number {
		return this.in - this.out;
	}
}

/** 一个采样窗口的事件循环延迟 / GC / 内存 / CPU */
class Samplers {
	private loop = monitorEventLoopDelay({ resolution: 10 });
	private observer: PerformanceObserver | null = null;
	private memTimer: NodeJS.Timeout | null = null;
	private gcCount = 0;
	private gcMs = 0;
	private rssPeak = 0;
	private heapPeak = 0;
	private cpuMark: NodeJS.CpuUsage | null = null;
	private threadMark: NodeJS.CpuUsage | null = null;
	private cpusMark: { busy: number; total: number } | null = null;
	private wallStart = 0;

	start(): void {
		// reset() 只清桶, 不会让直方图开始计数; 缺 enable() 时读到的分位数恒为 0
		this.loop.enable();
		this.loop.reset();
		this.gcCount = 0;
		this.gcMs = 0;
		this.rssPeak = process.memoryUsage().rss;
		this.heapPeak = 0;
		this.observer ??= new PerformanceObserver(list => {
			for (const entry of list.getEntries()) {
				this.gcCount++;
				this.gcMs += entry.duration;
			}
		});
		this.observer.observe({ entryTypes: ["gc"] });
		this.memTimer = setInterval(() => {
			const m = process.memoryUsage();
			if (m.rss > this.rssPeak) this.rssPeak = m.rss;
			if (m.heapUsed > this.heapPeak) this.heapPeak = m.heapUsed;
		}, 200);
		this.cpuMark = process.cpuUsage();
		this.threadMark = threadCpu();
		this.cpusMark = cpuTotal();
		this.wallStart = performance.now();
	}

	stop(): WindowMetric {
		const wallMs = performance.now() - this.wallStart;
		const cpuDelta = process.cpuUsage(this.cpuMark!);
		const processPercent = ((cpuDelta.user + cpuDelta.system) / 1000) / wallMs * 100;
		// 进程 CPU 含所有线程, 线程 CPU 只有 JS 那一条: 两者之差就是"不是主线程在跑"的证据
		const threadDelta = this.threadMark ? threadCpu(this.threadMark) : null;
		const threadPercent = threadDelta
			? ((threadDelta.user + threadDelta.system) / 1000) / wallMs * 100
			: null;

		const now = cpuTotal();
		// os.cpus 的计时在 Windows 上粒度较粗, 窗口太短时差值不可信:
		// 拿不到至少一半的理论增量就当"测不准", 而不是拿一个 0%~100% 的随机数去熔断
		let systemPercent: number | null = null;
		if (now && this.cpusMark) {
			const span = now.total - this.cpusMark.total;
			if (span >= wallMs * coreCount * 0.5) systemPercent = (now.busy - this.cpusMark.busy) / span * 100;
		}

		const mem = process.memoryUsage();
		if (mem.rss > this.rssPeak) this.rssPeak = mem.rss;
		if (mem.heapUsed > this.heapPeak) this.heapPeak = mem.heapUsed;

		this.observer?.disconnect();
		if (this.memTimer) clearInterval(this.memTimer);
		this.memTimer = null;
		this.loop.disable();

		return {
			loopDelay: {
				p50Ms: this.loop.percentile(50) / 1e6,
				p99Ms: this.loop.percentile(99) / 1e6,
				maxMs: this.loop.max / 1e6,
			},
			gc: { count: this.gcCount, totalMs: this.gcMs },
			cpu: { processPercent, systemPercent, threadPercent },
			memory: {
				rssPeakMb: this.rssPeak / 1048576,
				heapPeakMb: this.heapPeak / 1048576,
			},
		};
	}
}

/**
 * 一个采样窗口的环境指标
 *
 * cpu 只到"进程/整机"两个原始值: 静置基线、归因份额那些要等档位数据齐了才算,
 * 所以不写成 Pick<StepMetric, "cpu"> —— 那会把还没算出来的字段也要求上。
 */
type WindowMetric = Pick<StepMetric, "loopDelay" | "gc" | "memory"> & {
	cpu: { processPercent: number; systemPercent: number | null; threadPercent: number | null };
};

/**
 * 当前线程(JS 主线程)的 CPU 时间, 单位 µs
 *
 * 只有 Node >= 24 有 process.threadCpuUsage; 拿不到就返回 null, 由调用方跳过对比。
 * 用它把"进程在烧 CPU"拆成"主线程在跑 JS"和"别的线程在内核/原生代码里转"两种情况 ——
 * 本次压测遇到的"统计一开就吃掉一整核"只有靠这一刀才分得开。
 */
function threadCpu(mark?: NodeJS.CpuUsage): NodeJS.CpuUsage | null {
	const fn = (process as unknown as { threadCpuUsage?: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage })
		.threadCpuUsage;
	if (typeof fn !== "function") return null;
	try {
		return mark ? fn(mark) : fn();
	} catch {
		return null;
	}
}

/** 静置基线: 除窗口指标外, 还带上这段时间里活跃的 libuv 句柄种类计数 */
type IdleBaseline = WindowMetric & { handles: string };

/** 整机 CPU 时间快照; os.cpus 不可用时返回 null, 该项指标记 0 */
function cpuTotal(): { busy: number; total: number } | null {
	let cpus: os.CpuInfo[];
	try {
		cpus = os.cpus();
	} catch {
		return null;
	}
	let busy = 0;
	let total = 0;
	for (const cpu of cpus) {
		const t = cpu.times as unknown as Record<string, number>;
		for (const [key, value] of Object.entries(t)) {
			total += value;
			if (key !== "idle") busy += value;
		}
	}
	return { busy, total };
}

/* ────────────────────────────── 熔断 ────────────────────────────── */

const LIMITS = {
	/** 发生器跟不上目标速率(被丢弃的比例上限) */
	shedRatio: 0.03,
	/** 同步处理尾延迟上限(ms); 样本不足 100 条时改用单次最大值判定 */
	syncP99Ms: 30,
	/** 单条消息卡住的绝对上限(ms): 样本太少时也要能抓到"一次卡死" */
	syncMaxMs: 200,
	loopP99Ms: 100,
	rssPeakMb: 1200,
	systemCpuPercent: 88,
	pendingPeak: 5000,
	/** 判定"是这台机器在抢 CPU 而不是框架饱和"的门槛: 相对空转基线多花的进程 CPU 上限 */
	noiseCpuAboveIdle: 35,
	/** 同上, 主线程被消息链占用的比例上限 —— 两者都低却掉速, 就是外部干扰 */
	noiseBusyRatio: 0.25,
	/** 空转(零消息)就吃掉超过这么多单核 CPU, 视为装配自身在空转, 要在报告里点名 */
	idleCpuPercent: 25,
};

/** 熔断判定: 带类别, 因为"环境在忙"和"框架到顶了"处置方式完全不同 */
type Verdict = { kind: "load" | "noise"; text: string };

function judge(m: StepMetric): Verdict | null {
	// 掉速/整机满, 但本进程并没随加压多花 CPU、消息链也不忙 —— 是邻居抢了时间片,
	// 不该记在框架头上(处置: 重测这一档, 见 runScenario)
	const noise = m.cpu.aboveIdlePercent < LIMITS.noiseCpuAboveIdle
		&& m.busyRatio < LIMITS.noiseBusyRatio
		&& m.cpu.unexplainedPercent < LIMITS.noiseCpuAboveIdle;

	const shedRatio = m.offered > 0 ? m.shed / m.offered : 0;
	if (shedRatio > LIMITS.shedRatio) {
		const text = `跟不上目标速率, 丢弃 ${(shedRatio * 100).toFixed(1)}%`;
		return noise ? { kind: "noise", text: `疑似环境干扰(${text})` } : { kind: "load", text };
	}
	if (m.sync.n >= 100 && m.sync.p99 > LIMITS.syncP99Ms) return { kind: "load", text: `同步 p99 ${m.sync.p99.toFixed(2)}ms > ${LIMITS.syncP99Ms}ms` };
	if (m.sync.max > LIMITS.syncMaxMs) return { kind: "load", text: `单条同步处理 ${m.sync.max.toFixed(1)}ms > ${LIMITS.syncMaxMs}ms` };
	if (m.loopDelay.p99Ms > LIMITS.loopP99Ms) return { kind: "load", text: `事件循环 p99 ${m.loopDelay.p99Ms.toFixed(1)}ms > ${LIMITS.loopP99Ms}ms` };
	if (m.memory.rssPeakMb > LIMITS.rssPeakMb) return { kind: "load", text: `RSS 峰值 ${m.memory.rssPeakMb.toFixed(0)}MB > ${LIMITS.rssPeakMb}MB` };
	if (m.cpu.systemPercent !== null && m.cpu.systemPercent > LIMITS.systemCpuPercent) {
		const text = `整机 CPU ${m.cpu.systemPercent.toFixed(1)}% > ${LIMITS.systemCpuPercent}%`;
		return noise ? { kind: "noise", text: `疑似环境干扰(${text})` } : { kind: "load", text };
	}
	if (m.pendingPeak > LIMITS.pendingPeak) return { kind: "load", text: `在途 handler 峰值 ${m.pendingPeak} > ${LIMITS.pendingPeak}` };
	return null;
}

/* ────────────────────────────── 加压 ────────────────────────────── */

type RampResult = { offered: number; dispatched: number; shed: number; wallMs: number };

/** 一个档位里采集的原始耗时样本: 框架同步处理 + 压测台自身的事件构造 */
type Samples = { sync: number[]; gen: number[] };

/**
 * 开环定速: 每 10ms 一帧, 按"目标速率 × 已过时间"补发欠的条数。
 * 跟不上时不无限补(一帧灌几万条会把机器钉死), 超出 3 帧的部分记为 shed。
 *
 * offered 取 dispatched + shed 而不是"目标速率 × 时长": 后者在低速短窗口下会因
 * 帧边界的取整差出一条, 看着像掉速其实没有。真正"跟不上目标速率"的信号是 shed。
 */
function runRamp(rig: Rig, src: TrafficSource, rate: number, durationMs: number, s: Samples): Promise<RampResult> {
	const sliceMs = 10;
	const catchUpCap = Math.ceil(rate * sliceMs * 3 / 1000);
	const start = performance.now();
	let dispatched = 0;
	let shed = 0;

	return new Promise(resolve => {
		const frame = () => {
			const elapsed = performance.now() - start;
			if (elapsed >= durationMs) {
				resolve({ offered: dispatched + shed, dispatched, shed, wallMs: elapsed });
				return;
			}
			const due = Math.max(0, Math.floor(rate * elapsed / 1000) - dispatched - shed);
			const batch = Math.min(due, catchUpCap);
			shed += due - batch;

			for (let i = 0; i < batch; i++) {
				// 事件构造单独计时: 它算不进框架, 但确实吃进程的 CPU,
				// 不量它就分不清"机器被压测台自己占满"和"框架跑不动"
				const tGen = performance.now();
				const event = src.next();
				s.gen.push(performance.now() - tGen);

				const t0 = performance.now();
				rig.bot.dispatch(event, META);
				s.sync.push(performance.now() - t0);
				dispatched++;
			}
			setTimeout(frame, Math.max(1, sliceMs - (elapsed % sliceMs)));
		};
		frame();
	});
}

/** 饱和采样: 窗口内不计速率连续派发 */
function runBurst(rig: Rig, src: TrafficSource, durationMs: number, s: Samples): RampResult {
	const start = performance.now();
	let dispatched = 0;
	while (performance.now() - start < durationMs) {
		const tGen = performance.now();
		const event = src.next();
		s.gen.push(performance.now() - tGen);

		const t0 = performance.now();
		rig.bot.dispatch(event, META);
		s.sync.push(performance.now() - t0);
		dispatched++;
	}
	const wallMs = performance.now() - start;
	return { offered: dispatched, dispatched, shed: 0, wallMs };
}

/* ────────────────────────────── 单档测量 ────────────────────────────── */

type StepMetric = {
	targetRate: number;
	mode: "ramp" | "burst";
	wallMs: number;
	offered: number;
	dispatched: number;
	shed: number;
	achievedRate: number;
	/** 框架侧同步处理耗时(Bot.dispatch -> 返回), ms */
	sync: Stats;
	/** 压测台构造事件的耗时, ms —— 用来把机器占用归因清楚 */
	gen: Stats;
	/** 事件构造 -> 适配器 handler 收到 Action, ms; 含微任务/定时器排队 */
	e2e: Stats;
	/** 同步处理耗时合计 / 窗口时长: 主线程被消息链占用的比例 */
	busyRatio: number;
	actions: number;
	pendingPeak: number;
	loopDelay: { p50Ms: number; p99Ms: number; maxMs: number };
	cpu: {
		processPercent: number;
		systemPercent: number | null;
		/** JS 主线程自己花的 CPU; 与 processPercent 的差值就是非主线程(原生/内核)那部分 */
		threadPercent: number | null;
		/** 相对本场景空转基线多花的进程 CPU */
		aboveIdlePercent: number;
		/** 能归因到"同步处理 + 事件构造"的份额 */
		attributedPercent: number;
		/** 多出来却说不出去处的那份: 框架异步续跑、落盘、GC, 或被抢占 */
		unexplainedPercent: number;
	};
	memory: { rssPeakMb: number; heapPeakMb: number };
	gc: { count: number; totalMs: number };
	breach: string | null;
	kind: "load" | "noise" | null;
	/** 本档是否因环境干扰重测过 */
	retried: boolean;
};

async function measureStep(
	rig: Rig,
	src: TrafficSource,
	sink: Sink,
	cfg: ScenarioConfig,
	rate: number,
	burst: boolean,
	idle: WindowMetric | null,
	retried = false,
): Promise<StepMetric> {
	sink.reset();
	const samples: Samples = { sync: [], gen: [] };
	let pendingPeak = 0;

	const samplers = new Samplers();
	samplers.start();
	const watch = setInterval(() => {
		if (sink.pending > pendingPeak) pendingPeak = sink.pending;
	}, 100);

	let result: RampResult;
	if (burst) {
		result = runBurst(rig, src, opt.burstMs, samples);
	} else {
		result = await runRamp(rig, src, rate, opt.stepMs, samples);
	}

	clearInterval(watch);
	const window = samplers.stop();
	const sync = summarize(samples.sync);
	const gen = summarize(samples.gen);
	const e2e = summarize(sink.e2e);

	const busyRatio = (sync.mean * sync.n) / result.wallMs;
	const aboveIdle = window.cpu.processPercent - (idle?.cpu.processPercent ?? 0);
	const attributed = busyRatio * 100 + (gen.mean * gen.n) / result.wallMs * 100;

	const metric: StepMetric = {
		targetRate: rate,
		mode: cfg.mode,
		wallMs: result.wallMs,
		offered: result.offered,
		dispatched: result.dispatched,
		shed: result.shed,
		achievedRate: result.dispatched / (result.wallMs / 1000),
		sync,
		gen,
		e2e,
		busyRatio,
		actions: sink.actions,
		pendingPeak,
		loopDelay: window.loopDelay,
		cpu: {
			...window.cpu,
			aboveIdlePercent: aboveIdle,
			attributedPercent: attributed,
			unexplainedPercent: aboveIdle - attributed,
		},
		memory: window.memory,
		gc: window.gc,
		breach: null,
		kind: null,
		retried,
	};
	const verdict = judge(metric);
	metric.breach = verdict?.text ?? null;
	metric.kind = verdict?.kind ?? null;
	return metric;
}

/**
 * 只覆盖测量窗口的 CPU profiler
 *
 * 不用 `--cpu-prof`: 它记的是进程全程, 装配阶段(建库、扫插件、读文件)能占掉一半采样,
 * 热点表就变成启动画像而不是消息链画像。这里在窗口前后开停, 落盘成 V8 .cpuprofile,
 * 交给 scripts/bench/summarize-cpu-profile.mjs 聚合。
 */
class WindowProfiler {
	private readonly session = new inspector.Session();
	private running = false;

	constructor(private readonly file: string) {
		this.session.connect();
	}

	start(): void {
		if (this.running) return;
		this.session.post("Profiler.enable");
		this.session.post("Profiler.start");
		this.running = true;
	}

	stop(): Promise<void> {
		if (!this.running) return Promise.resolve();
		this.running = false;
		return new Promise((resolve, reject) => {
			this.session.post("Profiler.stop", (err: Error | null, result: { profile: unknown }) => {
				if (err) return reject(err);
				fsSync.writeFileSync(this.file, JSON.stringify(result.profile));
				resolve();
			});
		});
	}
}

/**
 * 给一次采样窗口套上 CPU profile
 *
 * 阶梯模式下每档都覆写同一个文件, 留下的就是最后(通常也最忙)那一档的画像。
 * 记 profile 本身有开销, 被包住的那一档数字会偏慢, 只用来做函数级归因, 不进容量口径。
 */
async function withProfile<T>(cfg: ScenarioConfig, run: () => Promise<T>): Promise<T> {
	if (!opt.cpuProf) return await run();
	const prof = new WindowProfiler(path.join(opt.cpuProf, `${cfg.id}.cpuprofile`));
	prof.start();
	try {
		return await run();
	} finally {
		await prof.stop();
	}
}

function sayProfNote(cfg: ScenarioConfig): void {
	if (opt.cpuProf) say(`    CPU profile(仅采样窗口): ${path.join(opt.cpuProf, `${cfg.id}.cpuprofile`)}`);
}

/** 空转基线: 装配就绪后一条消息都不派发, 量这套设施自己花掉的 CPU 与循环延迟 */
async function measureIdle(windowMs: number): Promise<IdleBaseline> {
	const samplers = new Samplers();
	// 空转却有很高的 CPU 时, 光看数字分不清是"谁在跑"—— 把活跃句柄种类记下来对比。
	// 注意 Windows 的目录监听不出现在这份名单里, 监听泄漏只能靠"删掉被监听的目录后
	// 还烧不烧"来判定, 见 leakCheck
	const handles = new Map<string, number>();
	const take = () => {
		for (const kind of process.getActiveResourcesInfo()) {
			handles.set(kind, (handles.get(kind) ?? 0) + 1);
		}
	};
	const sampleTimer = setInterval(take, 500);
	samplers.start();
	await sleep(windowMs);
	clearInterval(sampleTimer);
	const top = [...handles]
		.map(([kind, count]) => `${kind}x${count}`)
		.sort((a, b) => b.localeCompare(a))
		.join(" ");
	return { ...samplers.stop(), handles: top };
}

/* ────────────────────────────── 场景执行 ────────────────────────────── */

type ScenarioResult = {
	id: string;
	label: string;
	note: string;
	/** 静置基线: 预热过一轮流量后不收消息, 这套装配自己花掉的 CPU(含统计缓冲定时落盘) */
	idle: IdleBaseline | null;
	peakSustainable: number | null;
	maxThroughput: number | null;
	steps: StepMetric[];
	aborted: string | null;
	abortedKind: "load" | "noise" | null;
};

const blank = (): Samples => ({ sync: [], gen: [] });

/** 静置窗口(ms): 要长于统计的冲刷间隔, 才能把定时落盘的空转成本一并量进来 */
const IDLE_WINDOW_MS = 6000;

/**
 * 静置探针: 只回答"零消息时这 1 个核是谁在烧", 不测吞吐
 *
 * 装几轮、每轮按固定窗口连续采样, 用来区分三种可能:
 * - 越往后越忙 -> 有东西在按周期累积(定时器/降采样)
 * - 只有第二轮起才忙 -> 上一轮拆解后留下了自转的东西(泄漏)
 * - 从头忙到尾且主线程占比 ≈ 0 -> 不是 JS 在跑, 是原生线程
 */
async function probeScenario(cfg: ScenarioConfig, rounds: number, windows: number, windowMs: number): Promise<ScenarioResult> {
	const startedAt = performance.now();
	say(`\n### 静置探针 ${cfg.label} [${cfg.id}] | ${rounds} 轮 × 每轮 ${windows} 个 ${windowMs / 1000}s 窗口`);

	for (let round = 1; round <= rounds; round++) {
		const dir = await fs.mkdtemp(path.join(root, "data", "bench", `${cfg.id}-p${round}-`));
		const rig = await buildRig(cfg, dir);
		const src = new TrafficSource(cfg, rig);
		src.prime();
		const sink = new Sink();
		sink.install();
		say(`  第${round}轮: 装配完成, 进程已活 ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

		for (let i = 1; i <= windows; i++) {
			const w = await measureIdle(windowMs);
			const thread = w.cpu.threadPercent === null ? "n/a" : `${w.cpu.threadPercent.toFixed(1)}%`;
			say(`    窗口${i}: 进程 ${w.cpu.processPercent.toFixed(1)}% | 主线程 ${thread} | 循环 p99 ${w.loopDelay.p99Ms.toFixed(1)}ms | GC ${w.gc.totalMs.toFixed(1)}ms | ${w.handles}`);
		}

		await teardownRig(rig);
		sink.uninstall();
		await sleep(500);
	}

	return {
		id: cfg.id, label: cfg.label, note: cfg.note, idle: null,
		peakSustainable: null, maxThroughput: null, steps: [], aborted: null, abortedKind: null,
	};
}

/**
 * 监听泄漏体检: 正常释放一套设施, 立刻删掉它的沙盒目录, 再静置一段
 *
 * Windows 上"目录被删而 fs.watch 还开着"会让进程烧掉一个核且永不停歇,
 * 是这次压测里观测到的空转的唯一来源(隔离复现: 删目录后 99%, 关掉监听回落到 0%)。
 * 这里的口径只问一件事: 按框架自己的 dispose 链用完即删之后, 进程还烧不烧。
 * 烧 -> 有该关没关的监听; 不烧 -> 释放是完整的。
 */
async function leakCheck(cfg: ScenarioConfig, rounds: number, windowMs: number): Promise<void> {
	say(`\n### 监听泄漏体检 [${cfg.id}] | ${rounds} 轮 | 每轮: 装配 -> 静置 ${windowMs / 1000}s -> 释放并删目录 -> 再静置 ${windowMs / 1000}s`);

	for (let round = 1; round <= rounds; round++) {
		const dir = await fs.mkdtemp(path.join(root, "data", "bench", `${cfg.id}-leak${round}-`));
		const rig = await buildRig(cfg, dir);

		const before = await measureIdle(windowMs);

		await rig.bot.dispose();
		await rig.core.close();
		try { rig.db.close(); } catch { /* 已关闭 */ }
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch (e) {
			say(`  第${round}轮: 沙盒删除失败(${e instanceof Error ? e.message : e}), 本轮判定不成立`);
			continue;
		}

		const after = await measureIdle(windowMs);
		const leaked = after.cpu.processPercent > LIMITS.idleCpuPercent;
		say(`  第${round}轮: 释放前 ${before.cpu.processPercent.toFixed(1)}% -> 删除沙盒后 ${after.cpu.processPercent.toFixed(1)}% | 循环 p99 ${after.loopDelay.p99Ms.toFixed(1)}ms | ${leaked ? "! 目录已删仍有东西在烧核 —— 监听没关干净" : "干净"}`);
	}
}

async function runScenario(cfg: ScenarioConfig): Promise<ScenarioResult> {
	const dir = await fs.mkdtemp(path.join(root, "data", "bench", `${cfg.id}-`));
	const rig = await buildRig(cfg, dir);
	const src = new TrafficSource(cfg, rig);
	src.prime();

	const sink = new Sink();
	sink.install();

	const result: ScenarioResult = {
		id: cfg.id, label: cfg.label, note: cfg.note, idle: null,
		peakSustainable: null, maxThroughput: null, steps: [], aborted: null, abortedKind: null,
	};
	say(`\n### ${cfg.label} [${cfg.id}]`);
	say(`    ${cfg.note}`);

	// JIT 预热: 低速档位的样本少, 若第一条消息还带着未编译的字节码去计时,
	// 量出来的"框架开销"其实是解释执行的代价
	await runRamp(rig, src, 300, 1000, blank());
	// 静置基线放在预热之后、且窗口长于冲刷间隔: 统计缓冲里还压着预热那轮的记录,
	// 这一段时间能把"定时落盘 + 降采样"的空转成本一并量出来
	result.idle = await measureIdle(IDLE_WINDOW_MS);
	const idle = result.idle;
	say(`    静置基线: 进程 CPU ${idle.cpu.processPercent.toFixed(1)}%(单核=100) | 循环 p99 ${idle.loopDelay.p99Ms.toFixed(1)}ms | GC ${idle.gc.totalMs.toFixed(1)}ms`);
	say(`    静置活跃句柄: ${idle.handles}`);
	if (idle.cpu.processPercent > LIMITS.idleCpuPercent) {
		say(`    ! 零消息时空转就占掉 ${idle.cpu.processPercent.toFixed(0)}% 单核 —— 装配自身在耗 CPU, 报告要点名`);
	}

	say(tableHeader());

	if (cfg.mode === "burst") {
		// 先短时预热, 让 JIT 把热路径编译到位再掐吞吐天花板
		await runRamp(rig, src, 200, 800, blank());
		const step = await withProfile(cfg, () => measureStep(rig, src, sink, cfg, 0, true, idle));
		result.steps.push(step);
		say(tableRow(step));
		result.maxThroughput = Math.round(step.achievedRate);
		result.peakSustainable = Math.round(step.achievedRate);
		sayProfNote(cfg);
		await teardownRig(rig);
		sink.uninstall();
		return result;
	}

	// 连续被外部环境干扰的档数: 见下方处置
	let noiseStreak = 0;
	for (const rate of opt.ladder) {
		await runRamp(rig, src, rate, opt.warmupMs, blank());
		await sleep(200);
		let step = await withProfile(cfg, () => measureStep(rig, src, sink, cfg, rate, false, idle));
		if (step.kind === "noise") {
			// 掉速却没有任何"本进程变忙"的证据 —— 先当作邻居抢占, 静置后重测一次再定性
			say(`  → ${step.breach} | 进程 CPU 未随加压上升, 按环境干扰静置 3s 重测本档`);
			await sleep(3000);
			step = await withProfile(cfg, () => measureStep(rig, src, sink, cfg, rate, false, idle, true));
		}
		result.steps.push(step);
		say(tableRow(step));
		sayProfNote(cfg);
		result.maxThroughput = Math.max(result.maxThroughput ?? 0, Math.round(step.achievedRate));
		if (step.breach) {
			if (step.kind === "noise") {
				// 外部抢占不是框架饱和: 本档作废但不停手 —— 别人的负载不会因为我们加压而变好,
				// 只有连续两档都被抢才认为这台机器此刻测不出东西
				noiseStreak++;
				if (noiseStreak < 2) {
					say(`  → ${step.breach} 定性为环境干扰, 本档作废, 继续加压(连续两档受扰才收手)`);
					await sleep(opt.gapMs);
					continue;
				}
			} else noiseStreak = 0;
			result.aborted = `${rate} msg/s: ${step.breach}`;
			result.abortedKind = step.kind;
			// 重测过一次仍破阈才停: 阶梯是往上加的, 机器已经不稳时继续加压只会更糟
			say(`  → 熔断, 本场景不再继续加压${step.kind === "noise" ? "(连续受环境干扰, 非框架饱和)" : ""}`);
			break;
		}
		noiseStreak = 0;
		result.peakSustainable = rate;
		await sleep(opt.gapMs);
	}

	await teardownRig(rig);
	sink.uninstall();
	return result;
}

function tableHeader(): string {
	return [
		"目标/s    实际/s  送达率  同步mean    p95      p99      max   e2e p99   忙比  循环p99  CPU进 超静置   未知  CPU机 RSS峰  GCms 状态",
		"-".repeat(140),
	].join("\n");
}

function tableRow(m: StepMetric): string {
	const achieved = m.offered ? m.dispatched / m.offered * 100 : 100;
	const f = (n: number, w: number, d = 2) => (Number.isFinite(n) ? n : 0).toFixed(d).padStart(w);
	return [
		m.mode === "burst" ? "burst".padStart(7) : String(m.targetRate).padStart(7),
		f(m.achievedRate, 8, 0),
		f(achieved, 6, 1),
		f(m.sync.mean, 9, 3), f(m.sync.p95, 7, 3), f(m.sync.p99, 7, 3), f(m.sync.max, 7, 2),
		f(m.e2e.p99, 8, 1),
		f(m.busyRatio * 100, 5, 1),
		f(m.loopDelay.p99Ms, 8, 1),
		f(m.cpu.processPercent, 5, 0),
		f(m.cpu.aboveIdlePercent, 6, 0),
		f(m.cpu.unexplainedPercent, 6, 0),
		(m.cpu.systemPercent === null ? "    -" : f(m.cpu.systemPercent, 5, 0)),
		f(m.memory.rssPeakMb, 5, 0),
		f(m.gc.totalMs, 5, 0),
		m.breach ? `熔断: ${m.breach}` : (m.shed ? `shed ${m.shed}` : "ok"),
	].join(" ");
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const selected = SCENARIOS.filter(s => opt.scenarios.includes(s.id));
if (!selected.length) {
	say(`没有匹配的场景: ${opt.scenarios.join(",")}`);
	process.exit(1);
}

say("Chirucat 消息链路压测");
say(`机器: ${os.cpus().length} 逻辑核 / ${os.totalmem() / 1073741824} GB`);
say(`阶梯: ${opt.ladder.join(", ")} msg/s | 采样 ${opt.stepMs / 1000}s/档 | 预热 ${opt.warmupMs / 1000}s | 场景: ${selected.map(s => s.id).join(", ")}`);
say(`熔断: 丢弃>${LIMITS.shedRatio * 100}% | 同步p99>${LIMITS.syncP99Ms}ms(样本≥100) 或单次>${LIMITS.syncMaxMs}ms | 循环p99>${LIMITS.loopP99Ms}ms | RSS>${LIMITS.rssPeakMb}MB | 整机CPU>${LIMITS.systemCpuPercent}% | 在途>${LIMITS.pendingPeak}`);
say(`干扰判定: 掉速或整机超阈时, 若本进程相对静置基线没多花 ${LIMITS.noiseCpuAboveIdle}% CPU 且消息链占用 < ${LIMITS.noiseBusyRatio * 100}%, 记为环境干扰并重测该档`);

const results: ScenarioResult[] = [];
// 沙盒与结果都落在 data/bench: 前者是 mkdtemp 的父目录, 必须先在
await fs.mkdir(path.join(root, "data", "bench"), { recursive: true });
await fs.mkdir(path.dirname(opt.out), { recursive: true });
if (opt.cpuProf) await fs.mkdir(opt.cpuProf, { recursive: true });

// 环境噪声: 本进程静置 2s, 只看整机被邻居占到多少。之后所有"整机 CPU"都跟这个数比
const noiseWindow = await measureIdle(2000);
envSystemPercent = noiseWindow.cpu.systemPercent;
say(`开局整机噪声: ${envSystemPercent === null ? "测不准" : `${envSystemPercent.toFixed(1)}%`}(本进程静置时的整机占用, 含系统后台任务)`);

if (opt.leakCheck) {
	for (const cfg of selected) await leakCheck(cfg, opt.probeRounds, opt.probeWindowMs);
	await cleanSandboxes();
	process.exit(0);
}

for (const cfg of selected) {
	try {
		results.push(opt.probe
				? await probeScenario(cfg, opt.probeRounds, opt.probeWindows, opt.probeWindowMs)
				: await runScenario(cfg));
	} catch (e) {
		const detail = e instanceof Error ? e.stack : String(e);
		say(`场景 ${cfg.id} 失败: ${detail}`);
		results.push({
			id: cfg.id, label: cfg.label, note: cfg.note, idle: null,
			peakSustainable: null, maxThroughput: null,
			steps: [], aborted: `装配或运行失败: ${e instanceof Error ? e.message : e}`, abortedKind: null,
		});
	}
	// 场景之间留白: 让磁盘缓冲落完、CPU 回落
	await sleep(1500);
	await fs.writeFile(opt.out, JSON.stringify({
		options: opt,
		generatedAt: new Date().toISOString(),
		host: { cpus: coreCount, totalMemGb: Math.round(os.totalmem() / 1073741824), platform: `${os.platform()} ${os.release()}`, node: process.version },
		envSystemPercent,
		results,
	}, null, 2), "utf8");
}

say("\n场景汇总");
for (const r of results) {
	const last = r.steps[r.steps.length - 1];
	say([
		`  ${r.id.padEnd(9)}`,
		r.idle ? `静置 ${r.idle.cpu.processPercent.toFixed(0)}%` : "静置 -",
		`最高健康档 ${r.peakSustainable === null ? "-" : r.peakSustainable + " msg/s"}`,
		`实测峰值吞吐 ${r.maxThroughput === null ? "-" : r.maxThroughput + " msg/s"}`,
		last ? `末档同步mean ${last.sync.mean.toFixed(3)}ms p99 ${last.sync.p99.toFixed(2)}ms 忙比 ${(last.busyRatio * 100).toFixed(1)}%` : "",
		r.aborted ? `| ${r.abortedKind === "noise" ? "末档定性为环境干扰" : "末档熔断"}: ${r.aborted}` : "",
	].join(" | "));
}
say(`\n结果文件: ${path.relative(root, opt.out)}`);
await cleanSandboxes();

process.exit(results.every(r => r.steps.length === 0) ? 1 : 0);
