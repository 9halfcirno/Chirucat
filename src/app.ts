import path from "path";
import { Core } from "./core";
import Logger from "./utils/logger";
import { root } from "./utils/root";
import { readJSONOrCreate } from "./utils/readJSON";
import type { CoreOption } from "./types";
import { uuid } from "./utils/uuid";
import type { WebUIServerOptions } from "./webui/server/server";

const logger = new Logger("App");

/** 全局配置文件目录 */
const CONFIGS_DIR = path.join(root, "configs");

/** 关闭核心的超时时间(ms):超过后视为关闭失败,强制退出 */
const CLOSE_TIMEOUT = 10_000;

let core: Core | null = null;
let exiting = false;

/** 给异步操作加超时:超时后 reject,避免进程卡死 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

/**
 * 加载并组装核心配置选项
 */
export async function loadOptions(): Promise<CoreOption> {
	const coreRes = await readJSONOrCreate<CoreOption>(path.join(CONFIGS_DIR, "core.json"), { webui: true });
	if (coreRes.created) logger.log("配置文件缺失, 已生成默认配置: configs/core.json");
	const coreOption = coreRes.config;

	if (coreOption.webui !== false) {
		// webui 未显式关闭时, 把 webui.json 作为 WebUI 子配置一并传入
		const webuiRes = await readJSONOrCreate<WebUIServerOptions>(path.join(CONFIGS_DIR, "webui.json"), {
			password: uuid().replaceAll("-", "").slice(0, 10), // 默认生成随机字符串
			port: 7636,
			host: "127.0.0.1",
			frontConfig: {
				enableTestLab: false // 默认关闭test页面
			}
		});
		if (webuiRes.created) {
			logger.log("WebUI配置文件缺失, 已生成默认配置: configs/webui.json");
			logger.log(`=======================`);
			logger.log(`已生成初始密码: ${webuiRes.config.password}`);
			logger.log(`=======================`);
		}
		coreOption.webuiOption = webuiRes.config;
	}

	if (coreOption.statistics !== false) {
		// statistics 未显式关闭时, 把 statistics.json 作为子配置一并传入
		const statsRes = await readJSONOrCreate(path.join(CONFIGS_DIR, "statistics.json"), {
			flushIntervalMs: 5000,
			bufferSize: 500,
			detailRetentionDays: 7,
			hourlyRetentionDays: 30,
		});
		if (statsRes.created) logger.log("配置文件缺失, 已生成默认配置: configs/statistics.json");
		coreOption.statisticsOption = statsRes.config;
	}

	logger.log(`已加载配置: configs/core.json${coreOption.webuiOption ? ", configs/webui.json" : ""}`);
	return coreOption;
}

/**
 * 启动或重启 Chirucat 核心
 * @param options 可选传入配置，若未传入则重新读取配置文件
 */
export async function startCore(options?: CoreOption): Promise<Core> {
	if (core && !core.disposed) {
		logger.log("核心已在运行中，将先停止当前核心...");
		await stopCore();
	}

	logger.log("正在启动 Chirucat 核心...");
	try {
		const coreOption = options ?? (await loadOptions());
		core = new Core(coreOption);
		await core.init();
		logger.log("Chirucat 核心启动成功！");
		return core;
	} catch (e) {
		logger.error("Chirucat 核心启动失败: ", e);
		throw e;
	}
}

/**
 * 关闭当前运行中的 Chirucat 核心
 */
export async function stopCore(): Promise<void> {
	if (!core) return;
	if (core.disposed) {
		core = null;
		return;
	}

	logger.log("正在关闭 Chirucat 核心喵...");
	try {
		await withTimeout(core.close(), CLOSE_TIMEOUT, `关闭核心超时(${CLOSE_TIMEOUT}ms)`);
		logger.log("Chirucat 核心已关闭");
	} catch (e) {
		logger.error("关闭 Chirucat 核心时出错: ", e);
		throw e;
	} finally {
		core = null;
	}
}

/**
 * 统一的退出流程。
 */
async function exit(exitCode: number) {
	if (exiting) return;
	exiting = true;

	logger.log(`Chirucat 正在退出 (exitCode=${exitCode})`);

	try {
		await stopCore();
	} catch (e) {
		if (exitCode === 0) exitCode = 1; // 关闭失败视为异常退出
	}

	logger.log("Chirucat 已退出");

	process.exitCode = exitCode;
	setTimeout(() => process.exit(exitCode), 1000).unref();
}

// 全局异常兜底
process.on("unhandledRejection", (reason) => {
	logger.error("未捕获的 Promise 异常: ", reason);
	void exit(1);
});

process.on("uncaughtException", (e) => {
	logger.error("未捕获的异常: ", e);
	void exit(1);
});

// 进程退出信号注册
process.once("SIGINT", () => void exit(0));
process.once("SIGTERM", () => void exit(0));

// 作为主入口文件运行时直接启动
startCore().catch(async () => {
	await exit(1);
});

