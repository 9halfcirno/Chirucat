import os from "os";
import type { WebUIAPI } from "../types";

/**
 * 获取后端进程状态: GET /api/get_state
 *
 * 返回当前进程的详细运行数据, 供前端仪表盘展示:
 * - 进程信息: pid、启动时间、运行时长、Node 版本、平台、工作目录等
 * - 内存占用: process.memoryUsage() 各字段, 单位字节
 * - 系统资源: CPU 数量/型号/频率、系统内存、负载、系统运行时长等
 * - Core 概览: Bot/插件数量与运行状态 (独立启动 WebUI 时为 null)
 */
export default {
	path: "get_state",
	method: "GET",
	auth: true,

	handler(_, core) {
		const mem = process.memoryUsage();
		const cpus = os.cpus();
		const uptimeSec = process.uptime();
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
