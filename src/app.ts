import path from "path";
import { Core } from "./core";
import Logger from "./utils/logger";
import { root } from "./utils/root";
import { readJSONOrCreate } from "./utils/readJSON";
import type { CoreOption } from "./types";

const logger = new Logger("App");

/** 全局配置文件目录 */
const CONFIGS_DIR = path.join(root, "configs");

/** 关闭核心的超时时间(ms):超过后视为关闭失败,强制退出 */
const CLOSE_TIMEOUT = 10_000;

let core: Core | null = null;

let exiting = false;

/**
 * 统一的退出流程。
 * 信号(SIGINT/SIGTERM)、全局异常、启动失败都会汇合到这里:
 * 关闭核心(带超时兜底)→ 设置退出码 → 让事件循环自然结束,超时后强制退出。
 */
async function exit(exitCode: number) {
	if (exiting) return;
	exiting = true;

	logger.log(`Chirucat 正在退出 (exitCode=${exitCode})`);

	if (core) {
		logger.log("正在关闭 Chirucat 核心");
		try {
			await withTimeout(core.close(), CLOSE_TIMEOUT, `关闭核心超时(${CLOSE_TIMEOUT}ms)`);
			logger.log("Chirucat 核心已关闭");
		} catch (e) {
			logger.error("关闭 Chirucat 核心时出错: ", e);
			if (exitCode === 0) exitCode = 1; // 关闭失败视为异常退出
		}
	}

	logger.log("Chirucat 已退出");

	process.exitCode = exitCode;
	// 事件循环能自然结束则按 exitCode 退出;若有句柄未释放(如连接挂起),超时后强制退出
	setTimeout(() => process.exit(exitCode), 1000).unref();
}

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

// 全局异常兜底:记录后走统一退出流程,避免进程在未知状态下继续运行
process.on("unhandledRejection", (reason) => {
	logger.error("未捕获的 Promise 异常: ", reason);
	void exit(1);
});

process.on("uncaughtException", (e) => {
	logger.error("未捕获的异常: ", e);
	void exit(1);
});

appStart();

async function appStart() {
	logger.log("正在启动 Chirucat 核心")

	// 信号注册放在 init 之前:启动窗口期内按 Ctrl+C 也能走清理流程
	// 注意:必须用箭头函数包装,直接传 exit 会把信号名("SIGINT")当成 exitCode
	process.once("SIGINT", () => void exit(0));
	process.once("SIGTERM", () => void exit(0));

	try {
		// 读取 configs/ 下的配置, 组装成 CoreOption 后传给 Core
		// 配置文件缺失时自动生成默认配置, 避免用户误删后无法启动
		const coreRes = await readJSONOrCreate<CoreOption>(path.join(CONFIGS_DIR, "core.json"), { webui: true });
		if (coreRes.created) logger.log("配置文件缺失, 已生成默认配置: configs/core.json");
		const coreOption = coreRes.config;

		if (coreOption.webui !== false) {
			// webui 未显式关闭时, 把 webui.json 作为 WebUI 子配置一并传入
			const webuiRes = await readJSONOrCreate(path.join(CONFIGS_DIR, "webui.json"), {
				password: "chirucat",
				port: 7636,
				host: "127.0.0.1",
			});
			if (webuiRes.created) logger.log("配置文件缺失, 已生成默认配置: configs/webui.json");
			coreOption.webuiOption = webuiRes.config;
		}
		logger.log(`已加载配置: configs/core.json${coreOption.webuiOption ? ", configs/webui.json" : ""}`);

		core = new Core(coreOption);
		await core.init();
		logger.log("Chirucat 核心启动成功")
	} catch (e) {
		logger.error("Chirucat 核心启动失败", e)
		await exit(1); // 启动失败直接退出,不要让进程挂机
	}
}
