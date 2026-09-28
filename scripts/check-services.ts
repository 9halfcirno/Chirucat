/**
 * ServiceHost 行为检查: 验证 services/ 服务插件的发现、依赖、加载、导出与卸载契约。
 *
 * 这里检的都是"跑起来才知道"的行为, 光读代码确认不了:
 * - 只收 type: service 的插件, 其余类型跳过
 * - 依赖先于依赖者加载, 且 require 能拿到依赖导出
 * - 全局指令表与全局消息回调确实注册到了 ServiceHost
 * - 服务插件可导入 fs(可信), 受限加载器仍拒绝 fs 与 fs/promises
 * - dispose 释放导出、注销指令、调用 unload 钩子
 *
 * 用法:
 *   npx tsx scripts/check-services.ts
 *
 * 全程在系统临时目录内完成, 不触碰仓库数据; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot } from "../src/bot/bot";
import type { BotConfig } from "../src/bot/types";
import { Core } from "../src/core";
import { StateError } from "../src/errors/state-error";
import { PluginContextFactory } from "../src/plugin/contexts/factory";
import { PluginExports } from "../src/plugin/exports";
import { PluginLoader } from "../src/plugin/loader";
import { Plugin } from "../src/plugin/plugin";

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

/** 插件模块内记录调用顺序用的全局数组 */
const calls: string[] = [];
(globalThis as any).__calls = calls;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-services-"));
const restrictedDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-restricted-"));

async function makePlugin(
	root: string,
	id: string,
	manifest: Record<string, unknown>,
	source: string,
): Promise<string> {
	const pluginDir = path.join(root, id);
	await fs.mkdir(pluginDir, { recursive: true });
	await fs.writeFile(
		path.join(pluginDir, "manifest.json"),
		JSON.stringify({ id, version: "0.0.0", main: "index.ts", ...manifest }, null, "\t"),
	);
	await fs.writeFile(path.join(pluginDir, "index.ts"), source);
	return pluginDir;
}

console.log(`临时目录: ${dir}\n`);

/* ---------- 准备插件 ---------- */

// a: 基础服务, 注册全局指令/消息回调/事件过滤与观察, 发布导出, 并且导入 node:fs (服务插件不受限)
await makePlugin(dir, "a", { type: "service", name: "A" }, `
import fs from "node:fs";
export default {
	init(ctx) {
		globalThis.__calls.push("init-a");
		if (!fs.constants) throw new Error("fs 不可用");
		ctx.command.register("hello-a", () => { globalThis.__calls.push("cmd-a"); });
		ctx.message.includes("ping", () => { globalThis.__calls.push("msg-a"); });
		ctx.event.filter((e) => e.type === "message.create");
		ctx.event.observe((e) => { globalThis.__calls.push("observe:" + e.type); });
		ctx.exports = { value: 42 };
	},
	unload() { globalThis.__calls.push("unload-a"); }
};
`);

// b: 依赖 a, 通过 require 读取 a 的导出; 并注册一个必定抛错的过滤器
await makePlugin(dir, "b", { type: "service", name: "B", dependencies: { a: "any" } }, `
export default {
	init(ctx) {
		const a = ctx.require("a");
		globalThis.__calls.push("init-b:" + a.value);
		ctx.event.filter(() => { throw new Error("filter boom"); });
	}
};
`);

// 隐藏目录与散落文件: 都不是插件, 应被静默跳过
await makePlugin(dir, ".hidden", { type: "service" }, `
export default { init() { globalThis.__calls.push("init-hidden"); } };
`);
await fs.writeFile(path.join(dir, "readme.md"), "not a plugin");

// 非法: services/ 里放非 service 类型
await makePlugin(dir, "normal-in-services", { name: "N" }, `
export default { init() { globalThis.__calls.push("init-normal"); } };
`);

/* ---------- 1. 扫描 ---------- */

const core = new Core({ servicesStateFile: path.join(dir, "state.json") });
await core.services.scan(dir);

check(
	"scan 只登记 type: service 的插件",
	core.services.registry.has("a") && core.services.registry.has("b") && !core.services.registry.has("normal-in-services"),
	[...core.services.registry.keys()].join(","),
);
check(
	"跳过 . 开头的目录与散落文件",
	!core.services.registry.has(".hidden") && calls.length === 0,
	[...core.services.registry.keys()].join(","),
);
check("scan 后未加载模块(状态为 registered)", core.services.registry.get("a")?.status === "registered");

/* ---------- 2. 加载 ---------- */

const failedIds = await core.services.syncState();

check("syncState 全部加载成功", failedIds.length === 0 && core.services.enabledServices.length === 2, JSON.stringify({ failedIds, enabled: core.services.enabledServices.map(s => s.id) }));
check(
	"依赖先于依赖者加载",
	calls.indexOf("init-a") >= 0 && calls.indexOf("init-b:42") > calls.indexOf("init-a"),
	calls.join(","),
);
check("服务插件可导入 node:fs(不受限)", calls.includes("init-a"));

/* ---------- 3. 导出与全局能力 ---------- */

check(
	"服务导出进入全局导出表",
	core.services.exports.hasExports("a") && core.services.exports.getExports("a")?.value === 42,
	JSON.stringify(core.services.exports.ids()),
);

calls.length = 0;
const hit = core.services.command.exec("hello-a", []);
check("全局指令已注册进 ServiceHost 并可匹配", hit === "hello-a" && calls.includes("cmd-a"), String(hit));

calls.length = 0;
core.services.handleMessage({ text: "hello ping world" } as any);
check("全局消息回调被触发", calls.includes("msg-a"), calls.join(","));

/* ---------- 4. Bot 插件的 require 回退 ---------- */

// 普通插件拿不到 core, 只能通过上下文; 这里验证它确实能 require 到服务导出
const bot = new Bot({ id: "smoke", path: path.join(os.tmpdir(), "chirucat-smoke-bot") } as BotConfig, core);
const consumer = new Plugin({
	manifest: { id: "consumer", version: "0.0.0", main: "index.ts", path: dir },
	scope: "global",
	bot,
});
const ownExports = new PluginExports();
const ctx = PluginContextFactory.create(consumer, ownExports, core.services.exports);

check("Bot 插件可通过 ctx.require 读取服务导出", ctx.require<{ value: number }>("a")?.value === 42);

ownExports.setExports("a", { value: 7 });
check("本 Bot 插件导出优先于同名服务导出", ctx.require<{ value: number }>("a")?.value === 7);

let threw = false;
try {
	ctx.require("not-exist");
} catch (e) {
	threw = e instanceof StateError;
}
check("两层都没有导出时 require 抛 StateError", threw);

ctx.dispose();

/* ---------- 5. 事件过滤与观察 ---------- */

const msgEvent = { type: "message.create", time: Date.now(), platform: "test" } as any;
const otherEvent = { type: "notice.create", time: Date.now(), platform: "test" } as any;

// a 的过滤器只放行 message.create, b 的过滤器恒抛错 —— 抛错按放行处理, 不影响 a 的结论
check("过滤器放行符合条件的事件", core.services.filterEvent(msgEvent, bot) === true);
check("过滤器拦截不符合条件的事件", core.services.filterEvent(otherEvent, bot) === false, "notice.create 应被 a 拦截");

calls.length = 0;
core.services.observeEvent(msgEvent, bot);
check("观察回调被触发", calls.includes("observe:message.create"), calls.join(","));

/* ---------- 6. 受限加载器仍拒绝 fs ---------- */

const restricted = new PluginLoader();
for (const spec of ["node:fs", "node:fs/promises"]) {
	const id = "r-" + spec.replace(/[^a-z0-9]/gi, "-");
	const pluginDir = await makePlugin(restrictedDir, id, {}, `
import m from "${spec}";
export default { init() { void m; } };
`);
	let rejected = false;
	try {
		await restricted.load(path.join(pluginDir, "index.ts"));
	} catch (e) {
		rejected = /被拒绝的原生模块/.test(String(e));
	}
	check(`受限加载器拒绝 ${spec}`, rejected);
}

/* ---------- 7. Bot 插件目录拒收 service 类型 ---------- */

const botSideDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-bot-plugins-"));
await makePlugin(botSideDir, "wrong-place", { type: "service" }, `export default { init() {} };`);
await makePlugin(botSideDir, "ok-plugin", {}, `export default { init() {} };`);
await makePlugin(botSideDir, "depends-a", { dependencies: { a: "any" } }, `export default { init() { globalThis.__calls.push("init-depends-a"); } };`);

await bot.plugin.scan({ global: botSideDir, bot: path.join(botSideDir, "bot") });

check(
	"Bot 插件目录登记普通插件",
	bot.plugin.globalPlugins.has("ok-plugin"),
	[...bot.plugin.globalPlugins.keys()].join(","),
);
check(
	"Bot 插件目录跳过 service 类型插件",
	!bot.plugin.globalPlugins.has("wrong-place"),
	[...bot.plugin.globalPlugins.keys()].join(","),
);

let depended = true;
try {
	await bot.plugin.load("depends-a");
} catch (e) {
	depended = false;
	console.log(`        (load 抛错: ${e})`);
}
check(
	"Bot 插件的 dependencies 可指向服务插件",
	depended && calls.includes("init-depends-a"),
	calls.join(","),
);

/* ---------- 8. 插件自带原生模块(.node) ---------- */

// better-sqlite3 的 prebuild 是现成的有效原生模块, 用它验证 .node 被交给宿主 require 而非打包
const prebuild = path.resolve("node_modules", "better-sqlite3", "prebuilds", `${process.platform}-${process.arch}.node`);
if (existsSync(prebuild)) {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-native-"));
	const nativePluginDir = await makePlugin(nativeDir, "native", { type: "service" }, `
import binding from "./binding.node";
export default {
	init() { globalThis.__calls.push("init-native:" + typeof binding); }
};
`);
	await fs.copyFile(prebuild, path.join(nativePluginDir, "binding.node"));

	calls.length = 0;
	await core.services.scan(nativeDir);
	const nativeFailed = await core.services.syncState();

	check(
		"插件可自带原生模块(.node)并加载",
		nativeFailed.length === 0 && calls.includes("init-native:object"),
		JSON.stringify({ nativeFailed, calls }),
	);

	// Windows 上已 dlopen 的 .node 会被句柄占用, 删不掉是正常的, 留给系统清理
	await fs.rm(nativeDir, { recursive: true, force: true }).catch(() => { /* 忽略 */ });
} else {
	console.log(`  SKIP  原生模块检查(未找到 ${prebuild})`);
}

/* ---------- 9. 卸载 ---------- */

calls.length = 0;
await core.services.dispose();

check("dispose 卸载全部服务插件", core.services.enabledServices.length === 0, core.services.enabledServices.map(s => s.id).join(","));
check("卸载时释放导出", !core.services.exports.hasExports("a") && core.services.exports.ids().length === 0);
check("卸载时注销全局指令", core.services.command.commands.size === 0);
check("unload 钩子被调用", calls.includes("unload-a"), calls.join(","));

await fs.rm(dir, { recursive: true, force: true });
await fs.rm(restrictedDir, { recursive: true, force: true });
await fs.rm(botSideDir, { recursive: true, force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
