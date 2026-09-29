/**
 * 设置接口自检
 *
 * 走真实的 Core 与真实的 API handler, 但不启动 Bot、也不碰仓库里的 configs/:
 * Core 先按真实路径载入一次(只读), 随后把 webui 域换成指向临时文件的域, 于是
 * 所有写入都落在临时目录。脚本最后比对 configs/webui.json 的哈希, 自证没改过它。
 *
 * 用法:
 *   npx tsx scripts/check-settings-api.ts
 *
 * 退出码 0 表示全部通过。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";

import {
	CORE_SETTINGS_FILE,
	coreSettings,
	type CoreSettings,
} from "../src/config/settings/domains/core";
import { LOGGING_SETTINGS_FILE } from "../src/config/settings/domains/logging";
import {
	STATISTICS_SETTINGS_FILE,
	statisticsSettings,
	type StatisticsSettings,
} from "../src/config/settings/domains/statistics";
import {
	WEBUI_SETTINGS_FILE,
	webuiSettings,
	type WebUISettings,
} from "../src/config/settings/domains/webui";
import { root } from "../src/utils/root";
import { Bot } from "../src/bot/bot";
import { Core } from "../src/core";
import { WebUIServer } from "../src/webui/server/server";
import getBotConfig from "../src/webui/server/api/get_bot_config";
import getSettings from "../src/webui/server/api/get_settings";
import updateBotConfig from "../src/webui/server/api/update_bot_config";
import updateSettings from "../src/webui/server/api/update_settings";

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

const hashOf = async (file: string): Promise<string> =>
	createHash("sha256").update(await fs.readFile(file)).digest("hex");

/** 路径是否存在 */
const exists = async (p: string): Promise<boolean> => {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
};

/** 最小请求替身: handler 只读 req.body */
const req = (body?: unknown): Request => ({ body } as unknown as Request);

/** 整轮检查中必须原封不动的仓库配置 */
const guardedFiles = [
	WEBUI_SETTINGS_FILE,
	CORE_SETTINGS_FILE,
	STATISTICS_SETTINGS_FILE,
	LOGGING_SETTINGS_FILE,
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-settings-api-"));
const beforeHashes = await Promise.all(guardedFiles.map(hashOf));

const core = new Core({ webui: true, statistics: false });

try {
	/* ---------- 真实设置域: 按仓库里的路径载入一次 (只读) ---------- */
	console.log("[Core 接线]");
	await core.initSettings();
	const real = core.settings.domain<WebUISettings>("webui");
	check("Core 装配了 webui 设置域", real !== undefined);
	check("按真实文件载入得到数字端口", typeof real?.get().port === "number", String(real?.get().port));
	check("注册表能列出该域", core.settings.list().some((d) => d.id === "webui"));

	/* ---------- 换成临时值文件, 后续写入都不碰仓库 ---------- */
	core.settings.unregister("webui");
	const tmpFile = path.join(tmp, "webui.json");
	const domain = core.settings.register<WebUISettings>("webui", {
		definition: webuiSettings,
		file: tmpFile,
	});
	await domain.load();

	/* ---------- get_settings ---------- */
	console.log("\n[get_settings]");
	const snapshot = await getSettings.handler!(req(), core) as any;
	check("返回 success", snapshot.success === true);
	check("列出了 webui 域", snapshot.domains.some((d: any) => d.id === "webui"));

	const snap = snapshot.domains.find((d: any) => d.id === "webui");
	check("define 是 config-editor 能吃的 ConfigRoot 形状",
		Array.isArray(snap.define?.controls) && snap.define.controls.length > 0);
	// 契约来源: 前端入口 createConfigList 读的就是 define.controls —— 把它钉在源码上,
	// 免得下次又凭记忆定错形状(裸数组会渲染成空表单, 页面看起来"一个设置项都没有")
	const editorSource = await fs.readFile(
		path.join(root, "src", "webui", "public", "js", "spa", "components", "config-editor.js"),
		"utf-8",
	);
	check("契约与 config-editor 的实际读取方式一致",
		editorSource.includes("define?.controls"));
	check("投影里含分组 frontConfig",
		snap.define.controls.some((c: any) => c.type === "group" && c.id === "frontConfig"));
	check("端口投影成输入框(范围太大, 滑块没法用)",
		snap.define.controls.some((c: any) => c.type === "input" && c.id === "port"));
	check("含本机免密开关",
		snap.define.controls.some((c: any) => c.id === "localNoAuth" && c.type === "switch"));
	check("本机免密默认关闭", snap.values["localNoAuth"] === false);
	check("快照里的值已脱敏", snap.values["password"] === "");
	check("快照标出 restart 字段", snap.restartFields.length === 0, snap.restartFields.join(","));
	check("快照标出密码为密码框",
		snap.define.controls.some((c: any) => c.id === "password" && c.attr?.type === "password"));
	check("默认端口来自定义", snap.values["port"] === 7636);

	check("全局列表含 core 域", snapshot.domains.some((d: any) => d.id === "core"));
	check("统计模块关闭时仍能看到 statistics 域",
		snapshot.domains.some((d: any) => d.id === "statistics"));

	const coreSnap = snapshot.domains.find((d: any) => d.id === "core");
	check("core.webui 标为不可修改", coreSnap.immutableFields.includes("webui"));

	const statsSnap = snapshot.domains.find((d: any) => d.id === "statistics");
	check("统计参数读出来是数字", typeof statsSnap.values["flushIntervalMs"] === "number");
	check("统计 4 项都是热生效", statsSnap.restartFields.length === 0, statsSnap.restartFields.join(","));
	check("统计参数投影成滑块",
		statsSnap.define.controls.length === 4
		&& statsSnap.define.controls.every((c: any) => c.type === "slider"));

	const logSnap = snapshot.domains.find((d: any) => d.id === "logging");
	check("全局列表含 logging 域", logSnap !== undefined);
	check("日志级别是下拉选择",
		logSnap?.define?.controls?.some((c: any) => c.id === "level" && c.type === "select") === true);
	check("日志级别有四个选项",
		logSnap?.define?.controls?.find((c: any) => c.id === "level")?.items?.length === 4);
	check("日志级别是热生效(不标重启)", !logSnap?.restartFields?.includes("level"));
	check("日志级别默认值与 Logger 内置默认一致", logSnap?.values?.level === "debug");

	/* ---------- update_settings ---------- */
	console.log("\n[update_settings]");
	const saved = await updateSettings.handler!(
		req({ domain: "webui", patch: { port: "8123" } }), core,
	) as any;
	check("返回 success", saved.success === true);
	check("数字字符串被规范化成数字", saved.values["port"] === 8123);
	check("端口改动是热生效(无需重启)", saved.restartRequired.length === 0, saved.restartRequired.join(","));

	const onDisk = JSON.parse(await fs.readFile(tmpFile, "utf-8"));
	check("已落盘到值文件", onDisk.port === 8123);
	check("未提交的字段保留原值", onDisk.host === "127.0.0.1", JSON.stringify(onDisk));

	const hot = await updateSettings.handler!(
		req({ domain: "webui", patch: { frontConfig: { enableTestLab: true } } }), core,
	) as any;
	check("hot 字段不需要重启", hot.restartRequired.length === 0);

	/* ---------- 错误路径 ---------- */
	console.log("\n[错误路径]");
	let rejected: any = null;
	try {
		await updateSettings.handler!(req({ domain: "webui", patch: { port: 99999 } }), core);
	} catch (e) { rejected = e; }
	check("非法值被拒 (400)", rejected?.code === 400, JSON.stringify(rejected));
	check("错误带回字段级 details", Array.isArray(rejected?.details) && rejected.details.length > 0);

	let missing: any = null;
	try {
		await updateSettings.handler!(req({ domain: "nope", patch: {} }), core);
	} catch (e) { missing = e; }
	check("未知域返回 404", missing?.code === 404);

	let orphan: any = null;
	try { await getSettings.handler!(req(), undefined); } catch (e) { orphan = e; }
	check("WebUI 脱离核心时返回 503", orphan?.code === 503);

	/* 也把 core / statistics 换成临时文件: 下面的写入用例绝不能落到仓库里 */
	core.settings.unregister("core");
	const coreDomain = core.settings.register<CoreSettings>("core", {
		definition: coreSettings,
		file: path.join(tmp, "core.json"),
	});
	await coreDomain.load();

	core.settings.unregister("statistics");
	const statsDomain = core.settings.register<StatisticsSettings>("statistics", {
		definition: statisticsSettings,
		file: path.join(tmp, "statistics.json"),
	});
	await statsDomain.load();

	let webuiRejected: any = null;
	try {
		await updateSettings.handler!(req({ domain: "core", patch: { webui: false } }), core);
	} catch (e) { webuiRejected = e; }
	check("关闭 WebUI 的提交被拒 (400)", webuiRejected?.code === 400, JSON.stringify(webuiRejected));
	check("core.webui 未被改掉", coreDomain.get().webui === true);

	const statsSaved = await updateSettings.handler!(
		req({ domain: "statistics", patch: { bufferSize: 800 } }), core,
	) as any;
	check("统计参数可保存", statsSaved.values["bufferSize"] === 800);
	check("统计参数改动也是热生效", statsSaved.restartRequired.length === 0);

	/* ---------- 敏感字段 ---------- */
	console.log("\n[敏感字段]");
	await updateSettings.handler!(req({ domain: "webui", patch: { password: "CANARY_API" } }), core);
	check("明文只落在内存", domain.get().password === "CANARY_API");

	const after = await getSettings.handler!(req(), core) as any;
	const snapAfter = after.domains.find((d: any) => d.id === "webui");
	check("接口不回传明文", snapAfter.values["password"] === "");
	check("接口标出已设置的敏感字段", snapAfter.setSecrets.includes("password"));
	check("整个响应体不含明文", !JSON.stringify(after).includes("CANARY_API"));
	check("改密码也是热生效(仅会话失效, 无需重启)",
		(await updateSettings.handler!(
			req({ domain: "webui", patch: { password: "CANARY_API2" } }), core,
		) as any).restartRequired.length === 0);
	/* ---------- Bot 设置域 ---------- */
	console.log("\n[Bot 设置域]");
	const botDir = path.join(tmp, "bots", "probe");
	const botFile = path.join(botDir, "config.json");
	await fs.mkdir(botDir, { recursive: true });
	await fs.writeFile(botFile, JSON.stringify({ id: "probe", name: "探针" }, null, "\t"));

	// 直接构造 Bot: 走 scan 会去拉起插件与过滤名单, 超出本脚本的范围
	const bot = new Bot({ id: "probe", name: "探针", path: botDir }, core);
	await bot.settings.load();
	core.bot.bots.set("probe", bot);

	const botSnap = await getBotConfig.handler!(req({ id: "probe" }), core) as any;
	check("get_bot_config 返回该 Bot", botSnap.id === "probe");
	check("值来自 Bot 自己的 config.json", botSnap.values["name"] === "探针");
	check("id 被标为不可修改", botSnap.immutableFields.includes("id"));
	check("id 控件投影成只读",
		botSnap.define.controls.some((c: any) => c.id === "id" && c.attr?.disabled === "true"));
	check("Bot 域不出现在全局设置列表里",
		!(await getSettings.handler!(req(), core) as any).domains.some((d: any) => d.id.startsWith("bot:")));

	const botSaved = await updateBotConfig.handler!(
		req({ id: "probe", patch: { name: "新名字" } }), core,
	) as any;
	check("保存返回 success", botSaved.success === true);
	check("名称已落盘",
		JSON.parse(await fs.readFile(botFile, "utf-8")).name === "新名字");
	check("名称同步进运行中的 Bot", bot.name === "新名字");

	let idRejected: any = null;
	try {
		await updateBotConfig.handler!(req({ id: "probe", patch: { id: "renamed" } }), core);
	} catch (e) { idRejected = e; }
	check("改 id 被拒 (400)", idRejected?.code === 400, JSON.stringify(idRejected));
	check("目录没有被改名", await exists(botDir));

	let noBot: any = null;
	try { await getBotConfig.handler!(req({ id: "ghost" }), core); } catch (e) { noBot = e; }
	check("不存在的 Bot 返回 404", noBot?.code === 404);

	bot.settings.close();
	core.bot.bots.delete("probe");

	/* ---------- 热应用: 真实服务器上的换监听与鉴权 ---------- */
	console.log("\n[热应用]");
	const hotServer = new WebUIServer({
		core,
		port: 7711,
		host: "127.0.0.1",
		password: "hot-secret",
	});
	await hotServer.start();

	check("初始端口可用", (await fetch("http://127.0.0.1:7711/api/health")).ok);

	// 换端口: 旧监听关掉、新监听开起来 (设置页改端口走的就是这条路)
	await hotServer.relisten(7712, "127.0.0.1");
	check("relisten 后新端口可用", (await fetch("http://127.0.0.1:7712/api/health")).ok);

	let oldClosed = false;
	try { await fetch("http://127.0.0.1:7711/api/health"); } catch { oldClosed = true; }
	check("relisten 后旧端口已释放", oldClosed);

	// 有密码 + 未开本机免密: 本机照样要鉴权
	const denied = await fetch("http://127.0.0.1:7712/api/get_settings");
	check("有密码且未开本机免密时本机也被拦 (401)", denied.status === 401, String(denied.status));

	// 开本机免密: 同一台机器的请求直接放行
	hotServer.updateSecurity({ localNoAuth: true });
	const allowed = await fetch("http://127.0.0.1:7712/api/get_settings");
	check("开本机免密后本机请求放行", allowed.status === 200, String(allowed.status));

	// 换密码: 令牌由密码派生密钥签发, 旧令牌立刻失效(关掉免密才看得见)
	hotServer.updateSecurity({ password: "another-secret", localNoAuth: false });
	const afterPwd = await fetch("http://127.0.0.1:7712/api/get_settings");
	check("换密码后无令牌请求被拒 (401)", afterPwd.status === 401, String(afterPwd.status));

	await hotServer.close();
} finally {
	await core.close();
	await fs.rm(tmp, { recursive: true, force: true });
}

const afterHashes = await Promise.all(guardedFiles.map(hashOf));
console.log("");
guardedFiles.forEach((file, index) => {
	check(`仓库里的 ${path.relative(root, file)} 全程未被改动`,
		beforeHashes[index] === afterHashes[index]);
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
// 不直接 process.exit(): 本脚本跑过真实 HTTP 服务器与 fetch, handle 需要自然收尾 ——
// 在 Windows 上强行退出会撞 libuv 的 UV_HANDLE_CLOSING 断言。
// 兑底定时器是 unref 的: 正常情况进程先走, 它不会触发。
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 5000).unref();
