import os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import type { WebUIAPI } from "../../../types";

/**
 * 运行指标采样 (整机 CPU / 进程 CPU / 事件循环延迟)
 *
 * 这三项都没法「读一次就有值」, 全是两次采样之间的差值或窗口内的统计量:
 *
 * - 整机 CPU: os.cpus() 只给累计 CPU 时间, 相邻两次请求的差值才对应占用率。
 * - 进程 CPU: process.cpuUsage() 同理, 给的是本进程累计的 user/system 微秒。
 * - 事件循环: 用 perf_hooks 的延迟直方图, 读一次后 reset, 下次读到的就是这
 *   个窗口的统计量 (reset 之前是启动至今的累计, 放在首页上没有意义)。
 *
 * 快照都留在模块作用域里跨请求累积 —— 前端每 5s 拉一次, 相邻两次的差就是
 * 这 5s 的指标。多个标签页同时刷新会把窗口切得过短, 差值噪声大, 因此窗口
 * 不足 MIN_WINDOW_MS 时直接复用上一次的结果, 不重新采样 (也不 reset 直方图,
 * 免得把窗口越切越碎)。
 *
 * 首次请求没有「上一次」: 用模块加载时 (服务启动) 补的那一帧做基准, 窗口是
 * 「启动至今」, 数值偏平均值; 从第二次请求起就收敛到真实的刷新间隔。若服务
 * 刚起来就被请求 (窗口约等于 0, 累计时间还没动), 补等 COLD_WAIT_MS 再取一帧,
 * 免得前端首屏停在「—」上等满一个刷新周期。
 */

/** 两次采样之间的最小间隔 (ms); 不足则复用上次结果 */
const MIN_WINDOW_MS = 1_000;

/** 冷启动补采的等待时长 (ms), 只在这段时间没跑过 CPU 时用到 */
const COLD_WAIT_MS = 120;

/** 事件循环直方图的采样间隔 (ms); 50Hz 对 P99 足够, 也不至于频繁唤醒定时器 */
const LOOP_RESOLUTION_MS = 20;

/** 窗口内样本太少时不给事件循环延迟 (首帧只有个位数样本, P99 没有意义) */
const MIN_LOOP_SAMPLES = 20;

/** 一次采样的结果 */
interface PerfSample {
	/** 整机 CPU 占用率 (0~100 整数) */
	systemCpu: number | null;
	/** 进程自身 CPU 占用率 (单核为 100%, 多核可超过 100, 一位小数) */
	processCpu: number | null;
	/** 事件循环延迟 P99 (ms, 一位小数) */
	loopP99: number | null;
	/** 事件循环延迟最大值 (ms, 一位小数) */
	loopMax: number | null;
}

/** 保留一位小数 (指标都是小数值, 整数精度太粗) */
function round1(value: number) {
	return Math.round(value * 10) / 10;
}

/** CPU 累计时间快照 (各核 idle 与 total 之和, 单位 ms) */
function sampleCpuTimes() {
	let idle = 0;
	let total = 0;
	for (const { times } of os.cpus()) {
		idle += times.idle;
		total += times.user + times.nice + times.sys + times.idle + times.irq;
	}
	return { idle, total };
}

/**
 * 事件循环延迟直方图: 懒创建
 *
 * 常驻的 enable 会挂一个 50Hz 的定时器 —— 只有真的打开过首页才需要, 所以
 * 放在第一次采样时创建, 没访问过首页的实例一点开销都不多担。
 */
let loopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

function ensureLoopHistogram() {
	if (!loopHistogram) {
		loopHistogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
		loopHistogram.enable();
	}
	return loopHistogram;
}

/** 上一次快照 / 累计 CPU 时间 / 采样时刻 (模块级: 跨请求累积) */
let prevCpuTimes = sampleCpuTimes();
let prevProcUsage = process.cpuUsage();
let prevAt = Date.now();

/** 最近一次采样结果; 窗口过短时直接复用 */
let cached: PerfSample | null = null;

/** 同步取一帧: 三项指标一起算, 共用同一个时间窗口 */
function samplePerf(): PerfSample {
	const now = Date.now();
	const elapsed = now - prevAt;

	// ---- 整机 CPU: 各核累计时间的差值 ----
	const curTimes = sampleCpuTimes();
	const dTotal = curTimes.total - prevCpuTimes.total;
	const dIdle = curTimes.idle - prevCpuTimes.idle;
	prevCpuTimes = curTimes;

	// ---- 进程 CPU: 本进程累计微秒的差值 ----
	const curProc = process.cpuUsage();
	const dProc = (curProc.user - prevProcUsage.user) + (curProc.system - prevProcUsage.system);
	prevProcUsage = curProc;

	// ---- 事件循环: 读窗口统计量后立即 reset ----
	const hist = ensureLoopHistogram();
	const samples = hist.count;
	const loopP99 = samples >= MIN_LOOP_SAMPLES ? round1(hist.percentile(99) / 1e6) : null;
	const loopMax = samples >= MIN_LOOP_SAMPLES ? round1(hist.max / 1e6) : null;
	hist.reset();

	prevAt = now;

	// 差值非正 (系统时钟回退 / 两次采样在同一毫秒): 这一帧不算, 沿用上次结果
	const systemCpu = dTotal > 0
		? Math.min(100, Math.max(0, Math.round((1 - dIdle / dTotal) * 100)))
		: (cached?.systemCpu ?? null);

	// 单核为 100% 基准 (与 top 的 %CPU 一致): 累计微秒 / 墙钟毫秒 = 占单核的比例
	const processCpu = elapsed > 0 ? round1((dProc / 1000 / elapsed) * 100) : (cached?.processCpu ?? null);

	cached = { systemCpu, processCpu, loopP99, loopMax };
	return cached;
}

/** 读取这段时间的指标; 只有冷启动第一帧会短暂等待 */
async function readPerf(): Promise<PerfSample> {
	if (cached && Date.now() - prevAt < MIN_WINDOW_MS) return cached;

	const sample = samplePerf();
	if (sample.systemCpu != null) return sample;

	await new Promise((resolve) => setTimeout(resolve, COLD_WAIT_MS));
	return samplePerf();
}

/**
 * 获取后端进程状态: GET /api/core/state/get
 *
 * 返回当前进程的详细运行数据, 供前端仪表盘展示:
 * - 进程信息: pid、启动时间、运行时长、Node 版本、平台、工作目录等
 * - 内存占用: process.memoryUsage() 各字段, 单位字节
 * - 系统资源: CPU 数量/型号/频率/占用率、系统内存、负载、系统运行时长等
 * - Core 概览: Bot/插件数量与运行状态 (独立启动 WebUI 时为 null)
 */
export default {
	method: "GET",
	auth: true,

	// 冷启动第一帧要补等一小会儿才有 CPU 差值, 因此是异步处理器
	async handler(_, core) {
		const mem = process.memoryUsage();
		const cpus = os.cpus();
		const uptimeSec = process.uptime();
		const perf = await readPerf();
		const bots = core ? [...core.bot.bots.values()] : [];

		return {
			// ---- 进程 ----
			pid: process.pid,
			title: process.title,
			execPath: process.execPath,
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			cwd: process.cwd(),
			argv: process.argv,
			uptime: uptimeSec,
			startTime: Math.round(Date.now() - uptimeSec * 1000),
			/** 进程自身 CPU 占用率 (单核为 100%, 可超过 100), 由 process.cpuUsage 两次求差算出 */
			cpu: perf.processCpu,
			/** 事件循环延迟 (ms); 窗口内样本太少时为 null */
			eventLoop: { p99: perf.loopP99, max: perf.loopMax },

			// ---- 内存(字节) ----
			memory: {
				rss: mem.rss,
				heapTotal: mem.heapTotal,
				heapUsed: mem.heapUsed,
				external: mem.external,
				arrayBuffers: mem.arrayBuffers,
			},

			// ---- 系统 ----
			system: {
				hostname: os.hostname(),
				type: os.type(),
				platform: os.platform(),
				release: os.release(),
				arch: os.arch(),
				uptime: os.uptime(),
				totalmem: os.totalmem(),
				freemem: os.freemem(),
				loadavg: os.loadavg(), // Windows 上恒为 [0, 0, 0]
				cpus: {
					count: cpus.length,
					model: cpus[0]?.model ?? null,
					speed: cpus[0]?.speed ?? null,
					/** 整机 CPU 占用率 (0~100 整数), 由相邻两次请求的累计时间差算出 */
					usage: perf.systemCpu,
				},
			},

			// ---- Core 概览 ----
			hasCore: !!core,
			core: core
				? {
					botCount: bots.length,
					runningBotCount: bots.filter(bot => bot.running).length,
					pluginCount: bots.reduce(
						(sum, bot) => sum + bot.plugin.globalPlugins.size + bot.plugin.botPlugins.size,
						0
					),
					enabledPluginCount: bots.reduce(
						(sum, bot) => sum + bot.plugin.enabledPlugins.length,
						0
					),
					/** 服务插件 (services/ 目录): 注册总数与启用数 */
					servicePluginCount: core.services?.registry.size ?? 0,
					enabledServicePluginCount: core.services?.enabledEntities().length ?? 0,
					/**
					 * 本届核心的启动时刻 (ms)。核心可重启替换, 与进程的 startTime
					 * 不是一回事: 首页「已运行」用它, 进程信息卡才用 startTime。
					 */
					runningAt: core.runningAt,
					bots: bots.map(bot => ({
						id: bot.id,
						name: bot.name,
						running: bot.running,
					})),
				}
				: null,

			timestamp: Date.now(),
		};
	},
} as WebUIAPI;
