import path from "path";
import { Core } from "./core";
import Logger from "./utils/logger";
import { root } from "./utils/root";
import { readJSON, readJSONOrCreate } from "./utils/readJSON";
import type { CoreOption } from "./types";
import type { WebUIServerOptions } from "./webui/server/server";
import { CORE_SETTINGS_FILE, initialCoreSettings } from "./config/settings/domains/core";
import { WEBUI_SETTINGS_FILE, initialWebUISettings } from "./config/settings/domains/webui";
import {
	STATISTICS_SETTINGS_FILE,
	initialStatisticsSettings,
} from "./config/settings/domains/statistics";
import { buildWarning } from "./node-check";
import { ArgParseError, createParser, type ParseResult, type ValuesOf } from "./utils/cli";
import { features } from "./node-features";

const logger = new Logger("App");

/** 关闭核心的超时时间(ms):超过后视为关闭失败,强制退出 */
const CLOSE_TIMEOUT = 10_000;

/** 绝对路径转成相对仓库根的显示路径, 日志里给人看的 */
function displayPath(file: string): string {
	const rel = path.relative(root, file);
	return process.platform === "win32" ? rel.replaceAll("\\", "/") : rel;
}

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
 *
 * 各值文件"首次生成什么"都取自对应设置域导出的 initial* 工厂 —— 定义与首次
 * 默认值只有一处真相源, 不会出现 app.ts 与设置域各写一份、漂移后"谁先跑
 * 文件就长成谁的样子"(webui.json 的密码就曾因此一边随机、一边为空)。
 */
export async function loadOptions(): Promise<CoreOption> {
	const coreRes = await readJSONOrCreate<CoreOption>(CORE_SETTINGS_FILE, initialCoreSettings());
	if (coreRes.created) logger.log(`配置文件缺失, 已生成默认配置: ${displayPath(CORE_SETTINGS_FILE)}`);
	const coreOption = coreRes.config;

	if (coreOption.webui !== false) {
		// webui 未显式关闭时, 把 webui.json 作为 WebUI 子配置一并传入
		const webuiRes = await readJSONOrCreate<WebUIServerOptions>(WEBUI_SETTINGS_FILE, initialWebUISettings());
		if (webuiRes.created) {
			logger.log(`WebUI配置文件缺失, 已生成默认配置: ${displayPath(WEBUI_SETTINGS_FILE)}`);
			logger.log(`=======================`);
			logger.log(`已生成初始密码: ${webuiRes.config.password}`);
			logger.log(`=======================`);
		}
		coreOption.webuiOption = webuiRes.config;
	}

	if (coreOption.statistics !== false) {
		// statistics 未显式关闭时, 把 statistics.json 作为子配置一并传入
		const statsRes = await readJSONOrCreate(STATISTICS_SETTINGS_FILE, initialStatisticsSettings());
		if (statsRes.created) logger.log(`配置文件缺失, 已生成默认配置: ${displayPath(STATISTICS_SETTINGS_FILE)}`);
		coreOption.statisticsOption = statsRes.config;
	}

	logger.log(`已加载配置: ${displayPath(CORE_SETTINGS_FILE)}${coreOption.webuiOption ? `, ${displayPath(WEBUI_SETTINGS_FILE)}` : ""}`);
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
