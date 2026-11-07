import path from "path";
import { Core } from "./core";
import Logger from "./utils/logger";
import { root } from "./utils/root";
import { readJSON } from "./utils/readJSON";
import type { CoreOption } from "./types";
import { buildWarning } from "./node-check";
import { ArgParseError, createParser, type ParseResult, type ValuesOf } from "./utils/cli";
import { features } from "./node-features";

const logger = new Logger("App");

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
 * 启动或重启 Chirucat 核心
 *
 * 配置由 Core 在 init 时统一从设置域读取; options 只用于测试/嵌入式注入的
 * 显式覆盖(关掉 WebUI、统计或改服务状态文件路径), 正常启动不传。
 */
export async function startCore(options?: CoreOption): Promise<Core> {
	if (core && !core.disposed) {
		logger.log("核心已在运行中，将先停止当前核心...");
		await stopCore();
	}

	logger.log("正在启动 Chirucat 核心...");
	try {
		core = new Core(options);
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

	logger.log("正在关闭 Chirucat 核心...");
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



const argsSchema = {
	'no-ver-check': { type: 'boolean', default: false, desc: "跳过 Node 版本检查, 以不受控制的状态启动框架" },
	"help": { type: 'boolean', alias: 'h', desc: '显示帮助' },
} as const;
let args: ParseResult<ValuesOf<typeof argsSchema>>

const argsParser = createParser(argsSchema, { onWarn() { }, })
try {

	args = argsParser.parse(process.argv.slice(2));
} catch (e) {
	if (e instanceof ArgParseError) {
		console.error(`[${e.code}] ${e.message}`);
		process.exit(1);
	}
	throw e;
}

if (args.values["help"] === true) { // 显式带help
	let h = argsParser.help();
	logger.log(`\n============ Chirucat Help ===============\n${h}`)
	process.exit(0);
}

logger.log(`Chirucat V${(await readJSON(`${path.join(root, "package.json")}`)).version} =^ - ^= `)


let verCheck;
const nodeVer = process.versions.node.replace(/-(.*)/, "");

if (args.values.noVerCheck !== true) {// 进入前进行版本检查

	verCheck = buildWarning(nodeVer, features);

	if (verCheck) {
		// error 级不满足时继续跑只会得到段错误或"看起来没在跑"的静默失败, 早退比晚退诚实
		if (verCheck.blocking) logger.error(`\n${verCheck.text}`);
		else logger.warn(`\n${verCheck.text}`);
	}

	if (verCheck?.blocking) {
		logger.error("Node 版本不满足框架必需特性, 已中止启动 (exit 1)");
		void exit(1);
	}
} else {
	logger.warn(`Node 版本预检查已被关闭, 当前为 Node v${nodeVer}, 框架可能会出现意料之外的行为`)
}

// 作为主入口文件运行时直接启动;
// 被其他模块 import 时不启动核心
if (import.meta.main && !verCheck?.blocking) {
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
	startCore().catch(async () => {
		await exit(1);
	});
}
