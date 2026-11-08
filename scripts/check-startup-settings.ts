/**
 * 启动装配自检
 *
 * 覆盖: 设置域首次生成(created) → 启动参数来自设置域 → 设置页改动会反映到启动参数
 *       → 损坏值文件备份并按默认值重建(recovered) → 显式注入覆盖仍优先
 *       → app.ts 不再自己读配置 → before.service.enable 的取消语义
 *
 * 用法:
 *   npx tsx scripts/check-startup-settings.ts
 *
 * 全程使用系统临时目录, 不触碰仓库里的 configs/; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Core } from "../src/core";
import { Bot } from "../src/bot/bot";
import { root } from "../src/utils/root";
import { SettingsManager } from "../src/config/settings/manager";
import {
	CORE_DOMAIN_ID,
	coreSettings,
	initialCoreSettings,
	type CoreSettings,
} from "../src/config/settings/domains/core";
import {
	WEBUI_DOMAIN_ID,
	webuiSettings,
	initialWebUISettings,
	type WebUISettings,
} from "../src/config/settings/domains/webui";
import {
	STATISTICS_DOMAIN_ID,
	statisticsSettings,
	initialStatisticsSettings,
} from "../src/config/settings/domains/statistics";
import {
	LOGGING_DOMAIN_ID,
	loggingSettings,
} from "../src/config/settings/domains/logging";

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

async function rejects(fn: () => Promise<unknown>, fragment: string): Promise<boolean> {
	try {
		await fn();
		return false;
	} catch (e) {
		return e instanceof Error && e.message.includes(fragment);
	}
}

/** 按生产环境的四个域装配一份设置管理器, 只是把值文件指到临时目录 */
function makeManager(dir: string): SettingsManager {
	const manager = new SettingsManager();
	manager.register<CoreSettings>(CORE_DOMAIN_ID, {
		schema: coreSettings,
		file: path.join(dir, "core.json"),
		onCreate: initialCoreSettings,
	});
	manager.register<WebUISettings>(WEBUI_DOMAIN_ID, {
		schema: webuiSettings,
		file: path.join(dir, "webui.json"),
		onCreate: initialWebUISettings,
	});
	manager.register(STATISTICS_DOMAIN_ID, {
		schema: statisticsSettings,
		file: path.join(dir, "statistics.json"),
		onCreate: initialStatisticsSettings,
	});
	manager.register(LOGGING_DOMAIN_ID, {
		schema: loggingSettings,
		file: path.join(dir, "logging.json"),
	});
	return manager;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-startup-"));
const webuiFile = path.join(tmp, "webui.json");
console.log(`临时目录: ${tmp}\n`);

let serviceCore: Core | null = null;

try {
	/* ---------- 1. 首次启动: 值文件由设置域生成 ---------- */
	console.log("[首次生成]");
	const first = makeManager(tmp);
	const r1 = await first.loadAll();
	check("四个域全部载入成功", r1.loaded.length === 4 && r1.failures.length === 0);
	check("四个域都回报 created", r1.loaded.every(({ result }) => result.created));

	const raw = JSON.parse(await fs.readFile(webuiFile, "utf-8")) as WebUISettings;
	check("首次生成的 webui.json 带随机密码", typeof raw.password === "string" && raw.password.length === 10);
	check("首次生成的内容取自定义默认值", raw.port === 7636 && raw.host === "127.0.0.1");
	check("载入结果与落盘内容一致",
		r1.loaded.find(({ id }) => id === WEBUI_DOMAIN_ID)?.result.values.password === raw.password);

	/* ---------- 2. 启动参数来自设置域, 且改动会反映过来 ---------- */
	console.log("\n[启动装配]");
	const core = new Core();
	core.settings = first;
	const startup = core.resolveStartupSettings();
	check("启动开关来自 core 域", startup.webui === true && startup.statistics === true);
	check("WebUI 构造参数来自 webui 域",
		startup.webuiOption?.port === raw.port && startup.webuiOption?.password === raw.password);

	await first.domain<WebUISettings>(WEBUI_DOMAIN_ID)!.patch({ port: 8123 });
	await first.domain<CoreSettings>(CORE_DOMAIN_ID)!.patch({ statistics: false });
	const changed = core.resolveStartupSettings();
	check("设置页改动会反映到启动参数",
		changed.webuiOption?.port === 8123 && changed.statistics === false);
	check("改设置不会顺手改掉 webui 之外的开关", changed.webui === true);

	/* ---------- 3. 损坏文件: 备份 + 按默认值重建, 不阻断启动 ---------- */
	console.log("\n[损坏重建]");
	const broken = "{ 这不是合法 json";
	await fs.writeFile(webuiFile, broken, "utf-8");
	const second = makeManager(tmp);
	const r2 = await second.loadAll();
	const rebuiltResult = r2.loaded.find(({ id }) => id === WEBUI_DOMAIN_ID)?.result;
	check("启动不被损坏文件阻断", r2.failures.length === 0);
	check("损坏域回报 recovered", rebuiltResult?.recovered === true);
	check("原文件已备份且内容保留",
		!!rebuiltResult?.backupFile && await fs.readFile(rebuiltResult.backupFile, "utf-8") === broken);
	const rebuilt = JSON.parse(await fs.readFile(webuiFile, "utf-8")) as WebUISettings;
	check("重建内容是默认值且带新的随机密码",
		rebuilt.port === 7636 && rebuilt.host === "127.0.0.1"
		&& rebuilt.password.length === 10 && rebuilt.password !== raw.password);
	check("未损坏的域不报 recovered",
		r2.loaded.filter(({ result }) => result.recovered).length === 1);
	const afterRebuild = new Core();
	afterRebuild.settings = second;
	check("重建后启动参数仍能读到",
		afterRebuild.resolveStartupSettings().webuiOption?.password === rebuilt.password);

	/* ---------- 3.5 Bot 域是例外: id 的默认值是空串, 不能重建 ---------- */
	console.log("\n[Bot 域例外]");
	const botPath = path.join(tmp, "bot-probe");
	await fs.mkdir(botPath, { recursive: true });
	const botConfigFile = path.join(botPath, "config.json");
	await fs.writeFile(botConfigFile, broken, "utf-8");
	const bot = new Bot({ id: "bot-probe", name: "Probe", path: botPath }, core);
	check("Bot 域损坏时如实抛错", await rejects(() => bot.settings.load(), ""));
	check("Bot 域损坏文件保持原样", await fs.readFile(botConfigFile, "utf-8") === broken);
	check("Bot 域不生成备份/重建文件", (await fs.readdir(botPath)).length === 1);
	bot.settings.close();

	/* ---------- 4. 测试/嵌入式注入仍优先 ---------- */
	console.log("\n[注入覆盖]");
	const injected = new Core({ webui: false, statistics: false, servicesStateFile: path.join(tmp, "svc.json") });
	injected.settings = second;
	const overridden = injected.resolveStartupSettings();
	check("显式注入优先于设置域", overridden.webui === false && overridden.statistics === false);

	/* ---------- 5. app.ts 不再另读一份配置 ---------- */
	console.log("\n[入口收敛]");
	const appSrc = await fs.readFile(path.join(root, "src", "app.ts"), "utf-8");
	check("app.ts 不再有 loadOptions / readJSONOrCreate",
		!appSrc.includes("loadOptions") && !appSrc.includes("readJSONOrCreate"));
	const utilSrc = await fs.readFile(path.join(root, "src", "utils", "readJSON.ts"), "utf-8");
	check("readJSONOrCreate 已从工具层移除", !utilSrc.includes("readJSONOrCreate"));

	/* ---------- 6. 服务插件的 before.service.enable ---------- */
	console.log("\n[服务插件钩子]");
	const servicesDir = path.join(tmp, "services");
	const probeDir = path.join(servicesDir, "hook-probe");
	await fs.mkdir(probeDir, { recursive: true });
	await fs.writeFile(path.join(probeDir, "manifest.json"), JSON.stringify({
		id: "hook-probe", version: "0.0.0", main: "index.ts", type: "service", name: "HookProbe",
	}));
	await fs.writeFile(path.join(probeDir, "index.ts"),
		`export default { init() { (globalThis as any).__serviceInited = true; } };\n`);

	serviceCore = new Core({ servicesStateFile: path.join(tmp, "services-state.json") });
	await serviceCore.services.scan(servicesDir);
	let seen = "";
	serviceCore.hooks.register("before.service.enable", (service) => {
		seen = service.id;
		return { cancel: true };
	});
	check("取消时 load 抛错",
		await rejects(() => serviceCore!.services.load("hook-probe"), "启用被 Hook 取消"));
	check("钩子收到未启用的 Service 实例", seen === "hook-probe");
	check("取消后服务插件没有 init", (globalThis as any).__serviceInited !== true);
	check("取消后状态回到 registered",
		serviceCore.services.registry.get("hook-probe")?.status === "registered");
} finally {
	if (serviceCore) await serviceCore.services.dispose();
	await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
