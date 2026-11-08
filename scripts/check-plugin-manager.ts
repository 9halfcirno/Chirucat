/**
 * PluginManager 自检
 *
 * 状态管理重构第 0 批的基线之一: 在动 PluginManager / ServiceHost 之前, 把
 * 扫描对账、依赖图、加载顺序、失败回滚与 syncState 的现有行为钉住。
 *
 * 覆盖: 注册表对账(含 service 跳过 / bot 私有优先 / 悬空清理 / 实例复用)、
 *      依赖环与缺失依赖预检、服务依赖豁免、递归加载顺序、load/unload 幂等、
 *      Hook 取消、加载失败回滚、syncState 先卸后装与 failed[]、以及配置值文件
 *      **不做外部监听**(手工编辑不自动生效, 显式 load() 才重读)这一性能取舍。
 *      末两批补上启停连带落盘: 停用被依赖的插件时, 被连带卸载的依赖者要一并
 *      移出白名单(只写目标自身会让重启把整棵依赖树复活), 隐式拉起的依赖不进名单。
 *
 * 用法:
 *   npx tsx scripts/check-plugin-manager.ts
 *
 * 全程使用系统临时目录, 不触碰仓库里的 bots/ 与 configs/; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Core } from "../src/core";
import { Bot } from "../src/bot/bot";
import { ConfigManager } from "../src/config/manager";
import { Service } from "../src/plugin/services/service";
import type { PluginManifest } from "../src/plugin/types";

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

type Trace = string[];
const g = globalThis as unknown as { __pmTrace?: Trace };
g.__pmTrace = [];
const trace = (): string[] => [...(g.__pmTrace ?? [])];
const resetTrace = (): void => { g.__pmTrace = []; };

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => { setTimeout(resolve, ms); });

/** 造一个最小插件目录: 模块只往全局轨迹里记 init / unload */
async function makePlugin(
	dir: string,
	id: string,
	extra: Record<string, unknown> = {},
	initBody = "",
): Promise<string> {
	const pluginDir = path.join(dir, id);
	await fs.mkdir(pluginDir, { recursive: true });
	await fs.writeFile(
		path.join(pluginDir, "manifest.json"),
		JSON.stringify({ id, version: "0.0.0", main: "index.ts", ...extra }, null, "\t"),
	);
	await fs.writeFile(path.join(pluginDir, "index.ts"), `
export default {
	init() { (globalThis as any).__pmTrace.push("init:${id}"); ${initBody} },
	unload() { (globalThis as any).__pmTrace.push("unload:${id}"); },
};
`);
	return pluginDir;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-plugin-manager-"));
const globalDir = path.join(tmp, "plugins");
const botDir = path.join(tmp, "bot");
const botPluginDir = path.join(botDir, "plugins");
console.log(`临时目录: ${tmp}\n`);

const core = new Core({ servicesStateFile: path.join(tmp, "services-state.json") });
let bot: Bot | null = null;

try {
	/* ---------- 准备插件 ---------- */
	await makePlugin(globalDir, "a");
	await makePlugin(globalDir, "b", { dependencies: { a: "any" } });
	await makePlugin(globalDir, "cyc-x", { dependencies: { "cyc-y": "any" } });
	await makePlugin(globalDir, "cyc-y", { dependencies: { "cyc-x": "any" } });
	await makePlugin(globalDir, "missing", { dependencies: { ghost: "any" } });
	await makePlugin(globalDir, "svc-wrong", { type: "service" });
	await makePlugin(globalDir, "uses-service", { dependencies: { "svc-real": "any" } });
	await makePlugin(globalDir, "boom", {}, `throw new Error("boom from init");`);
	await makePlugin(botPluginDir, "a", { name: "BotPrivateA", config: "config.json" });
	// Bot 私有 a 的配置定义: 值文件按 <Bot目录>/configs/plugins/a.json 隔离
	await fs.writeFile(
		path.join(botPluginDir, "a", "config.json"),
		JSON.stringify({ controls: [{ type: "input", id: "title", label: "标题", default: "hello" }] }),
	);

	// 服务插件由 Core 先于 Bot 加载: 这里只往注册表里放一个占位, 用于验证
	// "依赖指向已注册服务" 不算缺失依赖, 也不需要 PluginManager 去加载它
	core.services.registry.set("svc-real", new Service({
		manifest: {
			id: "svc-real", version: "0.0.0", main: "index.ts",
			path: globalDir, type: "service",
		} satisfies PluginManifest,
		core,
	}));

	await fs.writeFile(
		path.join(botDir, "config.json"),
		JSON.stringify({ id: "probe-bot", name: "Probe" }),
	);
	await fs.writeFile(
		path.join(botDir, "state.json"),
		JSON.stringify({ enable: false, enabledPlugins: [] }),
	);
	bot = new Bot({ id: "probe-bot", name: "Probe", path: botDir }, core);
	const pm = bot.plugin;
	const scan = () => pm.scan({ global: globalDir, bot: botPluginDir });

	/* ---------- 1. 扫描与注册表对账 ---------- */
	console.log("[扫描与注册表]");
	await scan();
	check("普通插件登记到 global 注册表", pm.globalPlugins.has("a") && pm.globalPlugins.has("b"));
	check("放错位置的 service 类型被跳过", !pm.globalPlugins.has("svc-wrong"));
	check("bot 私有插件覆盖同名 global", pm.resolve("a") === pm.botPlugins.get("a"));
	check("依赖环在扫描时只告警、不阻断登记",
		pm.globalPlugins.has("cyc-x") && pm.globalPlugins.has("cyc-y"));
	check("注册后插件停在 registered", pm.resolve("a")?.status === "registered");

	/* ---------- 2. 依赖预检与递归加载 ---------- */
	console.log("\n[依赖预检与加载]");
	check("依赖环拒绝加载",
		await rejects(() => pm.load("cyc-x"), "依赖存在循环"));
	check("缺失依赖拒绝加载",
		await rejects(() => pm.load("missing"), "依赖未注册"));
	check("环/缺失预检失败不留下 loading 状态",
		pm.resolve("cyc-x")?.status === "registered" && pm.resolve("missing")?.status === "registered");
	check("依赖指向已注册服务不算缺失",
		!(await rejects(() => pm.load("uses-service"), "依赖未注册"))
		&& pm.resolve("uses-service")?.status === "enabled");

	resetTrace();
	await pm.load("b");
	const order = trace();
	check("按依赖顺序递归加载", pm.resolve("a")?.status === "enabled" && pm.resolve("b")?.status === "enabled");
	check("依赖先于依赖者 init",
		order.indexOf("init:a") >= 0 && order.indexOf("init:b") > order.indexOf("init:a"),
		order.join(","));
	await pm.load("b");
	check("load 幂等: 重复调用不再 init", trace().filter((l) => l === "init:b").length === 1);

	/* ---------- 2.5 配置值文件: 只响应程序化写入 ---------- */
	console.log("\n[配置值文件]");
	const aConfig = pm.resolve("a")?.config;
	const aConfigFile = ConfigManager.fileForPlugin(botDir, "a");
	check("启用后配置按默认值装配", aConfig?.get("title") === "hello");
	check("宿主不给配置实例挂文件监听",
		typeof (aConfig as unknown as Record<string, unknown> | undefined)?.startWatching !== "function");
	await fs.writeFile(aConfigFile, JSON.stringify({ title: "from-disk" }));
	await sleep(300); // 覆盖 100ms 防抖窗口, 排除"只是还没触发"
	check("手工编辑值文件不会自动同步进运行中的插件", aConfig?.get("title") === "hello");
	await aConfig?.load();
	check("显式 load() 才读到手工编辑的值", aConfig?.get("title") === "from-disk");

	/* ---------- 3. syncState: 先卸后装与 failed[] ---------- */
	console.log("\n[状态收敛]");
	const failedList = await pm.syncState(["a", "b", "ghost"]);
	check("未注册的期望项进入 failed", failedList.includes("ghost"), failedList.join(","));
	check("单个期望项失败不阻断其余插件",
		pm.resolve("a")?.status === "enabled" && pm.resolve("b")?.status === "enabled");

	resetTrace();
	const failedList2 = await pm.syncState(["uses-service"]);
	const convergeTrace = trace();
	check("收敛返回空 failed", failedList2.length === 0, failedList2.join(","));
	check("期望外的插件被卸载", pm.resolve("a")?.status !== "enabled" && pm.resolve("b")?.status !== "enabled");
	check("先卸载再加载",
		convergeTrace.some((l) => l.startsWith("unload:"))
		&& convergeTrace.findIndex((l) => l.startsWith("unload:"))
			< convergeTrace.findIndex((l) => l === "init:uses-service"),
		convergeTrace.join(","));

	const empty = await pm.syncState([]);
	check("空期望全部卸载", empty.length === 0 && pm.enabledPlugins.length === 0);
	check("卸载后插件不再持有配置实例", pm.resolve("a")?.config === null);
	await fs.writeFile(aConfigFile, JSON.stringify({ title: "after-unload" }));
	await sleep(150);
	check("已释放的配置实例不会被外部改动唤醒", aConfig?.get("title") === "from-disk");

	/* ---------- 4. 失败回滚与 Hook 取消 ---------- */
	console.log("\n[失败回滚]");
	check("init 抛错时 load 抛错", await rejects(() => pm.load("boom"), "boom from init"));
	check("失败后回到加载前的关态", pm.resolve("boom")?.status === "registered");
	check("失败后不残留运行上下文", pm.resolve("boom")?.context === null);

	resetTrace();
	const unsub = core.hooks.register("before.plugin.enable", (p) =>
		p.id === "a" ? { cancel: true } : undefined);
	check("Hook 取消时 load 抛错", await rejects(() => pm.load("a"), "启用被 Hook 取消"));
	check("取消后插件没有 init", !trace().includes("init:a"));
	check("取消后回到加载前的关态(disabled) 而非卡在 loading",
		pm.resolve("a")?.status === "disabled", String(pm.resolve("a")?.status));
	unsub();

	/* ---------- 5. 清单对账: 重建 / 复用 / 悬空清理 ---------- */
	console.log("\n[清单对账]");
	const bBefore = pm.globalPlugins.get("b");
	await fs.writeFile(
		path.join(globalDir, "b", "manifest.json"),
		JSON.stringify({ id: "b", version: "0.0.0", main: "index.ts", name: "B2", dependencies: { a: "any" } }),
	);
	await scan();
	check("清单变化且未启用时重建实例", pm.globalPlugins.get("b") !== bBefore);

	await pm.load("a");
	const aEnabled = pm.resolve("a");
	await fs.writeFile(
		path.join(botPluginDir, "a", "manifest.json"),
		JSON.stringify({ id: "a", version: "0.0.0", main: "index.ts", name: "Changed", config: "config.json" }),
	);
	await scan();
	check("已启用实例不被清单变化替换", pm.resolve("a") === aEnabled);

	await fs.rm(path.join(globalDir, "cyc-x"), { recursive: true, force: true });
	await scan();
	check("目录中消失的非活跃条目被清理", !pm.globalPlugins.has("cyc-x"));
	check("悬空清理不动已启用实例", pm.resolve("a")?.status === "enabled");

	/* ---------- 6. 启停连带落盘: 关的是一棵树而不是一个插件 ---------- */
	console.log("\n[启停连带落盘]");
	const stateFile = path.join(botDir, "state.json");
	/** 直接读盘核对期望名单: 连带有没有落盘, 只看文件 */
	const wanted = async (): Promise<string[]> => {
		const raw = JSON.parse(await fs.readFile(stateFile, "utf-8")) as { enabledPlugins?: string[] };
		return [...(raw.enabledPlugins ?? [])];
	};

	await pm.syncState([]);
	await bot.state.setState({ enable: true, enabledPlugins: [] });

	// b 依赖 a: 用户启用 b, a 被隐式拉起
	const onB = await pm.setEnabled("b", true);
	check("启用 b 连带拉起依赖 a",
		onB.enabled === true && onB.affected.includes("a") && pm.resolve("a")?.status === "enabled",
		JSON.stringify(onB));
	check("隐式拉起的依赖不进白名单", (await wanted()).join(",") === "b", JSON.stringify(await wanted()));

	// 关掉被依赖的 a: 连带卸载 b, b 的期望必须一并落盘 —— 只写 a 的话,
	// 重启后仍在名单里的 b 会沿加载递归把整棵树重新拉起
	const offA = await pm.setEnabled("a", false);
	check("停用 a 连带卸载依赖者 b",
		offA.enabled === false && offA.affected.includes("b") && pm.resolve("b")?.status !== "enabled",
		JSON.stringify(offA));
	check("连带卸载的依赖者一并移出白名单", (await wanted()).length === 0, JSON.stringify(await wanted()));

	// 重启口径: 期望态从盘上读回来再收敛, 整棵树不该复活
	await bot.state.load();
	const failedRestart = await pm.syncState();
	check("重启后依赖树不会被仍在名单里的插件拉起",
		failedRestart.length === 0 && pm.enabledPlugins.length === 0,
		JSON.stringify({ failedRestart, enabled: pm.enabledPlugins.map((p) => p.id) }));

	// 本来就关着的依赖者不构成本次变化: 它的期望是它自己的事
	await pm.load("b");
	await pm.unload("b");
	await bot.state.setState({ enable: true, enabledPlugins: ["b"] });
	const offBase = await pm.setEnabled("a", false);
	check("关着的依赖者不进 affected", offBase.affected.length === 0, offBase.affected.join(","));
	check("关着的依赖者不动它自己的期望", (await wanted()).join(",") === "b", JSON.stringify(await wanted()));
	await pm.syncState([]);

	/* ---------- 7. Bot 级入口(WebUI 走这条路): 关一次就该关住整棵树 ---------- */
	console.log("\n[Bot 级启停落盘]");
	// `Bot.start()` 的 global 目录固定是项目根的 plugins, 夹具因此放私有目录
	await makePlugin(botPluginDir, "cascade-base");
	await makePlugin(botPluginDir, "cascade-leaf", { dependencies: { "cascade-base": "any" } });
	await bot.state.setState({ enable: true, enabledPlugins: ["cascade-leaf"] });
	await bot.start();
	check("启动按白名单跑起依赖者并隐式拉起依赖",
		pm.resolve("cascade-leaf")?.status === "enabled" && pm.resolve("cascade-base")?.status === "enabled",
		`${pm.resolve("cascade-leaf")?.status}/${pm.resolve("cascade-base")?.status}`);

	// 用户关的是被依赖的那个: 运行态连带卸载依赖者, 期望名单要一起收回去
	const offCascade = await bot.setPluginEnabled("cascade-base", false);
	check("Bot.setPluginEnabled 回报被连带的依赖者",
		offCascade.enabled === false && offCascade.affected.includes("cascade-leaf"),
		JSON.stringify(offCascade));
	check("Bot.setPluginEnabled 把依赖者一并移出白名单",
		(await wanted()).length === 0, JSON.stringify(await wanted()));

	// 重启: 名单里再没有这棵树的任何节点, 它就该安静待着
	await bot.stop();
	await bot.state.load();
	await bot.start();
	check("Bot 重启后整棵依赖树保持关闭",
		pm.resolve("cascade-base")?.status !== "enabled" && pm.resolve("cascade-leaf")?.status !== "enabled",
		`${pm.resolve("cascade-base")?.status}/${pm.resolve("cascade-leaf")?.status}`);
	await bot.stop();
} finally {
	if (bot) {
		await bot.plugin.syncState([]).catch(() => {});
		bot.state.close();
		bot.settings.close();
	}
	await core.services.dispose().catch(() => {});
	await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
