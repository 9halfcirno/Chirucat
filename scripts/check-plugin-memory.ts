/**
 * ctx.memory 自检: 跨重载暂存的值规则与生命周期
 *
 * 要钉住的契约:
 * - 存进去和取出来都是副本, 插件手里的对象与暂存值互不影响;
 * - 函数 / Symbol / 循环引用在写入时就抛 StateError(而不是静默丢掉一个键),
 *   兄弟分支共享同一个对象不算环, 不能误伤;
 * - Date / Map / Set 这类结构化值原样取回; 类实例会被剥成普通对象(方法丢失);
 * - 服务插件: 停用再启用、扫描重建实体(WebUI 刷新服务页)、卸载再加载都还在,
 *   只有"目录从磁盘消失"和"换 Core(重启)"才清零;
 * - 桶按插件 id 归属, 插件之间互相看不见; Bot 插件同样有, 且随 Bot 实例销毁。
 *
 * 用法:
 *   npx tsx scripts/check-plugin-memory.ts
 *
 * 全程使用系统临时目录(状态文件也指到临时目录), 不触碰仓库里的 bots/ 与 configs/;
 * 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Bot } from "../src/bot/bot";
import { Core } from "../src/core";
import { StateError } from "../src/errors/state-error";
import { PluginMemory } from "../src/plugin/contexts/apis/memory";

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

/** 断言一次调用抛出 StateError 且消息里带上了原因关键词 */
function throwsState(fn: () => unknown, keyword: string): boolean {
	try {
		fn();
		return false;
	} catch (e) {
		return e instanceof StateError && e.message.includes(keyword);
	}
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-plugin-memory-"));
console.log(`临时目录: ${tmp}\n`);

/* ---------- 1. 值规则 ---------- */
console.log("[值规则]");

const store = new PluginMemory(new Map());

store.set("answer", 42);
store.set("nested", { list: [1, 2, { text: "hi" }] });
check("基本值往返", store.get("answer") === 42 && JSON.stringify(store.get("nested")) === `{"list":[1,2,{"text":"hi"}]}`);
check("缺失键回默认值", store.get("nope", "fallback") === "fallback" && store.has("nope") === false);
check("delete 报告是否真的删掉", store.delete("answer") === true && store.delete("answer") === false);

const original = { n: 1 };
store.set("byRef", original);
original.n = 2;
check("写入侧是副本: 改动本地对象不影响已存值", (store.get("byRef") as typeof original).n === 1);

const readBack = store.get("byRef") as typeof original;
readBack.n = 99;
check("读取侧是副本: 改动返回值不影响已存值", (store.get("byRef") as typeof original).n === 1);

const when = 1_700_000_000_000;
store.set("when", new Date(when));
store.set("counts", new Map([["a", 1]]));
store.set("tags", new Set(["x", "y"]));
check("Date 原样取回", store.get<Date>("when") instanceof Date && store.get<Date>("when")?.getTime() === when);
check("Map 原样取回", store.get<Map<string, number>>("counts")?.get("a") === 1);
check("Set 原样取回", store.get<Set<string>>("tags")?.has("x") === true);

class Widget {
	count = 1;
	bump(): void { this.count++; }
}
store.set("widget", new Widget());
const widget = store.get<Widget>("widget");
check("类实例被剥成普通对象(方法丢失)", widget?.count === 1 && typeof widget?.bump !== "function");

check("顶层函数被拒绝", throwsState(() => store.set("fn", () => {}), "函数"));
check("嵌套函数被拒绝", throwsState(() => store.set("obj", { onInit() {} }), "函数"));
check("数组里的函数被拒绝", throwsState(() => store.set("arr", [1, () => {}]), "函数"));
check("Symbol 被拒绝", throwsState(() => store.set("sym", Symbol("s")), "Symbol"));
check("错误消息带上了键名", throwsState(() => store.set("bad-key", () => {}), "bad-key"));
check("被拒的写入不留下半个键", store.has("obj") === false && store.has("arr") === false);

const self: Record<string, unknown> = { name: "loop" };
self["me"] = self;
check("自引用被拒绝", throwsState(() => store.set("loop", self), "循环引用"));

const parent: Record<string, unknown> = { name: "parent" };
const child: Record<string, unknown> = { parent };
parent["child"] = child;
check("深层循环引用被拒绝", throwsState(() => store.set("deep", parent), "循环引用"));

const shared = { hits: 1 };
store.set("siblings", { left: shared, right: shared });
check("兄弟分支共享同一对象不算环", store.get("siblings") !== undefined);

check("列表类方法可用", store.has("siblings") && store.keys().includes("nested") && store.size() === store.keys().length);
check("entries 的值也是副本", (() => {
	const found = store.entries().find(([key]) => key === "nested");
	(found![1] as { list: unknown[] }).list = [];
	return JSON.stringify(store.get("nested")) === `{"list":[1,2,{"text":"hi"}]}`;
})());

/* ---------- 2. 服务插件: 桶跨重载活下来 ---------- */

/** 记录插件里看到的计数, 插件与脚本之间用全局变量传话 */
const log: string[] = [];
(globalThis as any).__memoryLog = log;

const servicesDir = path.join(tmp, "services");

async function makeService(id: string, body: string): Promise<void> {
	const dir = path.join(servicesDir, id);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "manifest.json"),
		JSON.stringify({ id, version: "0.0.0", main: "index.ts", type: "service", name: id }, null, "\t"),
	);
	await fs.writeFile(path.join(dir, "index.ts"), body);
}

/** 每次 init 把计数 +1, 并把当前值发布出去 */
const counterSource = (id: string): string => `
export default {
	init(ctx) {
		const n = (ctx.memory.get("n") ?? 0) + 1;
		ctx.memory.set("n", n);
		ctx.exports = { n, keys: ctx.memory.keys(), other: ctx.memory.get("from-m1") };
		(globalThis as any).__memoryLog.push("${id}:" + n);
	},
};
`;

await makeService("m1", counterSource("m1"));
await makeService("m2", counterSource("m2"));
await makeService("m3", `
export default {
	init(ctx) { ctx.memory.set("handler", () => "我 registers 了个回调"); },
};
`);

const stateFile = path.join(tmp, "services-state.json");
const core = new Core({ servicesStateFile: stateFile });
await core.services.initState();
await core.services.scan(servicesDir);
await core.services.syncState();

console.log("\n[服务插件生命周期]");

const first = core.services.exports.getExports("m1") as { n: number };
check("首次加载从空桶开始", first?.n === 1, JSON.stringify(first));

await core.services.unload("m1");
await core.services.load("m1");
const second = core.services.exports.getExports("m1") as { n: number };
check("卸载再加载读到上一轮的暂存", second?.n === 2, JSON.stringify(second));

await core.services.setEnabled("m1", false);
await core.services.scan(servicesDir); // 关态实体会被重建: 桶不能跟着实体一起消失
await core.services.setEnabled("m1", true);
const third = core.services.exports.getExports("m1") as { n: number };
check("停用 + 扫描重建实体后仍在(WebUI 刷新服务页不清洗暂存)", third?.n === 3, JSON.stringify(third));

const m2 = core.services.exports.getExports("m2") as { n: number; keys: string[]; other: unknown };
check("每个插件各拿一只桶", m2?.n === 1 && m2?.other === undefined);
check("桶里只有自己的键", m2?.keys.join(",") === "n", m2?.keys.join(","));

// m3 的 init 想暂存一个回调: 加载必须失败, 且失败原因说得出"函数"
log.length = 0;
await core.services.load("m3").then(
	() => check("插件写入函数时载入失败", false, "竟然加载成功了"),
	(e: unknown) => check(
		"插件写入函数时载入失败, 原因可辨",
		e instanceof StateError && e.message.includes("函数") && log.length === 0,
		String(e)),
);
check("加载失败后停在关态", core.services.registry.get("m3")?.status !== "enabled");

/* ---------- 目录消失: 暂存随注册表条目一起丢弃 ---------- */

await core.services.setEnabled("m1", false);
await fs.rm(path.join(servicesDir, "m1"), { recursive: true, force: true });
await core.services.scan(servicesDir);
check("目录消失后注册表条目被清理", !core.services.registry.has("m1"));

await makeService("m1", counterSource("m1"));
await core.services.scan(servicesDir);
await core.services.setEnabled("m1", true);
const reborn = core.services.exports.getExports("m1") as { n: number };
check("同名插件重新出现时从空桶开始(暂存已随目录丢弃)", reborn?.n === 1, JSON.stringify(reborn));

/* ---------- 换 Core(重启): 清零 ---------- */

await core.services.dispose();
const reboot = new Core({ servicesStateFile: stateFile });
await reboot.services.initState();
await reboot.services.scan(servicesDir);
await reboot.services.syncState();
const afterRestart = reboot.services.exports.getExports("m1") as { n: number };
check("重启后清零(暂存只承诺跨重载, 不承诺跨进程)", afterRestart?.n === 1, JSON.stringify(afterRestart));
await reboot.services.dispose();

/* ---------- 3. Bot 插件: 同一套机制, 桶随 Bot 实例 ---------- */

console.log("\n[Bot 插件生命周期]");

const botDir = path.join(tmp, "bot");
const pluginDir = path.join(botDir, "plugins");
await fs.mkdir(pluginDir, { recursive: true });

async function makePlugin(id: string, body: string): Promise<void> {
	const dir = path.join(pluginDir, id);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "manifest.json"),
		JSON.stringify({ id, version: "0.0.0", main: "index.ts" }, null, "\t"),
	);
	await fs.writeFile(path.join(dir, "index.ts"), body);
}

await fs.writeFile(path.join(botDir, "config.json"), JSON.stringify({ id: "memory-bot", name: "Memory" }));
await fs.writeFile(path.join(botDir, "state.json"), JSON.stringify({ enable: false, enabledPlugins: [] }));
await makePlugin("p1", `
export default {
	init(ctx) {
		const n = (ctx.memory.get("n") ?? 0) + 1;
		ctx.memory.set("n", n);
		ctx.exports = { n };
	},
};
`);

/** 取这个 Bot 上 p1 暂存的计数 */
const countOf = (bot: Bot): unknown => bot.plugin.resolve("p1")?.context?.memory.get("n");

const bot1 = new Bot({ id: "memory-bot", name: "Memory", path: botDir }, core);
await bot1.plugin.scan({ global: path.join(tmp, "no-global-plugins"), bot: pluginDir });
await bot1.plugin.load("p1");
check("Bot 插件首次加载从空桶开始", countOf(bot1) === 1, `n=${String(countOf(bot1))}`);

await bot1.plugin.unload("p1");
await bot1.plugin.load("p1");
check("Bot 插件卸载再加载后暂存还在", countOf(bot1) === 2, `n=${String(countOf(bot1))}`);

// 换一个 Bot 实例(等价于该 Bot 重启): 桶属于宿主, 随实例一起换新
const bot2 = new Bot({ id: "memory-bot", name: "Memory", path: botDir }, core);
await bot2.plugin.scan({ global: path.join(tmp, "no-global-plugins"), bot: pluginDir });
await bot2.plugin.load("p1");
check("Bot 实例重建后清零", countOf(bot2) === 1, `n=${String(countOf(bot2))}`);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
