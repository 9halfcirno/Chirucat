/**
 * ConfigManager 自检
 *
 * 状态管理重构第 0 批的基线之一: 第 2 批要让它接入 JsonFileStore, 先把
 * 默认值、白名单规范化、coerce、落盘、监听与并发语义钉住。
 *
 * 特别钉住三条容易混淆/踩坑的边界: ConfigManager 的值文件语法错误是**抛出**的
 * (与 SettingsDomain 的"备份后按默认值重建"不同); `data` 是只读视图; 以及
 * **刻意不做值文件监听** —— 手工编辑不自动生效, 只有显式 `load()` 才重读,
 * 避免几十上百个插件同时启用时每个实例各挂一个 fs.watch。
 *
 * 用法:
 *   npx tsx scripts/check-config-manager.ts
 *
 * 全程使用系统临时目录; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigManager } from "../src/config/manager";
import type { ConfigRoot } from "../src/config/types";

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

const readValues = async (file: string): Promise<Record<string, any>> =>
	JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, any>;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => { setTimeout(resolve, ms); });

const schema: ConfigRoot = {
	version: "1.0.0",
	controls: [
		{ type: "input", id: "name", label: "名称", default: "chiru" },
		{ type: "switch", id: "enabled", label: "启用", default: true },
		{ type: "slider", id: "count", label: "数量", min: 0, max: 10, step: 1, default: 3 },
		{
			type: "group", id: "advanced", label: "高级", controls: [
				{ type: "input", id: "host", label: "主机", default: "127.0.0.1" },
			],
		},
		{
			type: "table", id: "rules", label: "规则", controls: [
				{ type: "input", id: "pattern", label: "模式", default: "*" },
				{ type: "switch", id: "on", label: "开", default: false },
			],
			default: [{ pattern: "ping", on: true }],
		},
		{ type: "text", label: "只作说明, 不产生值" },
	],
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-config-manager-"));
console.log(`临时目录: ${tmp}\n`);

try {
	/* ---------- 1. 默认值展开 ---------- */
	console.log("[默认值]");
	const cm = new ConfigManager(schema);
	const d = cm.defaults();
	check("按控件类型展开默认值",
		d.name === "chiru" && d.enabled === true && d.count === 3);
	check("group 递归展开", d.advanced?.host === "127.0.0.1");
	check("table 初始行按列默认值补全",
		Array.isArray(d.rules) && d.rules.length === 1
		&& d.rules[0].pattern === "ping" && d.rules[0].on === true);
	check("text 控件不产生值", Object.keys(d).length === 5, Object.keys(d).join(","));

	/* ---------- 2. 载入: 缺失生成 / 白名单规范化 / 语法错误 ---------- */
	console.log("\n[载入]");
	const file = path.join(tmp, "values.json");
	const cmFile = new ConfigManager(schema, file);
	await cmFile.load();
	check("文件缺失时按默认值建文件", (await readValues(file)).name === "chiru");
	check("load 后内存值完整", cmFile.values().count === 3 && cmFile.values().advanced.host === "127.0.0.1");

	await fs.writeFile(file, JSON.stringify({
		name: "custom", bogus: 42, advanced: { host: "0.0.0.0" },
	}));
	const cm2 = new ConfigManager(schema, file);
	await cm2.load();
	check("未知键被丢弃", !Object.prototype.hasOwnProperty.call(cm2.data, "bogus"));
	check("缺失键补默认值", cm2.data.enabled === true && cm2.data.count === 3);
	check("已有值保留", cm2.data.name === "custom" && cm2.data.advanced.host === "0.0.0.0");
	check("table 缺失时回落到控件默认行",
		cm2.data.rules.length === 1 && cm2.data.rules[0].pattern === "ping");
	check("get 支持点号路径", cm2.get("advanced.host") === "0.0.0.0");
	check("get 未命中时回落默认值", cm2.get("rules.0.on") === true);

	const broken = "{ 这不是合法 json";
	await fs.writeFile(file, broken);
	const cm3 = new ConfigManager(schema, file);
	check("值文件语法错误照常抛出(不静默覆盖)", await rejects(() => cm3.load(), ""));
	check("抛出后损坏文件保持原样", await fs.readFile(file, "utf-8") === broken);

	/* ---------- 3. update: coerce / 未提交字段 / group / table ---------- */
	console.log("\n[更新与规范化]");
	const file2 = path.join(tmp, "update.json");
	const cm4 = new ConfigManager(schema, file2);
	await cm4.load();
	await cm4.update({ name: "new" });
	check("update 保留未提交的键与隐藏项",
		cm4.data.enabled === true && cm4.data.count === 3
		&& cm4.data.advanced.host === "127.0.0.1" && cm4.data.rules.length === 1);
	check("update 已落盘", (await readValues(file2)).name === "new");

	await cm4.update({ advanced: { host: "10.0.0.1" } });
	check("group 内字段按提交值更新", cm4.data.advanced.host === "10.0.0.1");
	await cm4.update({ rules: [{ pattern: "abc" }] });
	check("table 整表替换、行内缺失列补默认",
		cm4.data.rules.length === 1 && cm4.data.rules[0].pattern === "abc"
		&& cm4.data.rules[0].on === false);

	/* ---------- 4. 变更监听 ---------- */
	console.log("\n[变更监听]");
	type Notice = { key: string; value: unknown; oldValue: unknown };
	const notices: Notice[] = [];
	const off = cm4.watch((key, value, oldValue) => { notices.push({ key, value, oldValue }); });
	await cm4.update({ name: "x", count: 7 });
	check("一次 update 逐字段通知",
		notices.some((n) => n.key === "name" && n.value === "x")
		&& notices.some((n) => n.key === "count" && n.value === 7),
		notices.map((n) => n.key).join(","));
	check("通知带上旧值", notices.find((n) => n.key === "count")?.oldValue === 3);
	notices.length = 0;
	await cm4.update({ name: "x" });
	check("无变化不通知", notices.length === 0);
	await cm4.load();
	check("load 视为载入、不通知", notices.length === 0);
	off();

	let survivorCalled = false;
	const offThrow = cm4.watch(() => { throw new Error("observer boom"); });
	const offSurvive = cm4.watch(() => { survivorCalled = true; });
	await cm4.update({ count: 8 });
	check("单个监听器抛错不影响其余监听器", survivorCalled);
	offThrow();
	offSurvive();

	/* ---------- 5. 并发与保存 ---------- */
	console.log("\n[并发与保存]");
	const file3 = path.join(tmp, "concurrent.json");
	const cm5 = new ConfigManager(schema, file3);
	await cm5.load();
	await Promise.all(Array.from({ length: 20 }, (_, i) => cm5.update({ count: i, name: `n${i}` })));
	const disk = await readValues(file3);
	check("并发 update 后内存与磁盘一致",
		cm5.data.count === disk.count && cm5.data.name === disk.name,
		`内存=${cm5.data.count}/${cm5.data.name}, 磁盘=${disk.count}/${disk.name}`);
	check("并发写不交错、最后一次改动胜出",
		cm5.data.count === 19 && cm5.data.name === "n19");
	await cm5.update({ count: 5 });
	const view = cm5.data;
	view.count = 999;
	check("data 是只读视图: 改副本不影响内部状态", cm5.data.count === 5);
	await cm5.save();
	check("save 落盘 store 当前值", (await readValues(file3)).count === 5);

	/* ---------- 6. updateSchema ---------- */
	console.log("\n[热更新 schema]");
	const narrow: ConfigRoot = {
		controls: [{ type: "input", id: "name", label: "名称", default: "chiru" }],
	};
	const beforeSchemaUpdate = await fs.readFile(file3, "utf-8");
	let schemaNotices = 0;
	const offSchema = cm5.watch(() => { schemaNotices++; });
	await cm5.updateSchema(narrow, { saveAfterUpdate: false, notifyChanges: false });
	check("按新 schema 收敛数据", Object.keys(cm5.data).length === 1 && cm5.data.name === "n19");
	check("saveAfterUpdate:false 不落盘", await fs.readFile(file3, "utf-8") === beforeSchemaUpdate);
	check("notifyChanges:false 不通知", schemaNotices === 0);
	await cm5.updateSchema(narrow);
	check("缺省 saveAfterUpdate 会落盘", (await readValues(file3)).name === "n19");
	offSchema();

	/* ---------- 7. 校验 ---------- */
	console.log("\n[校验]");
	check("validate 返回错误数组且合法值无错",
		Array.isArray(cm4.validate()) && cm4.validate().length === 0);
	check("validate 能指出完全不对的输入", cm4.validate([]).length > 0);

	/* ---------- 8. 刻意不做值文件监听 ---------- */
	console.log("\n[外部改动不自动生效]");
	const file4 = path.join(tmp, "watched.json");
	const cm6 = new ConfigManager(schema, file4);
	await cm6.load();
	const externalNotices: string[] = [];
	const offExternal = cm6.watch((key) => { externalNotices.push(key); });

	const api = cm6 as unknown as Record<string, unknown>;
	check("ConfigManager 不暴露文件监听入口",
		typeof api.startWatching !== "function" && typeof api.close !== "function");

	const edited = { ...cm6.data, name: "from-disk" };
	await fs.writeFile(file4, JSON.stringify(edited));
	await sleep(300); // 覆盖 store 的 100ms 防抖窗口, 排除"只是还没触发"
	check("手工编辑值文件不会重读进内存", cm6.data.name !== "from-disk", String(cm6.data.name));
	check("手工编辑不会触发 watch()", externalNotices.length === 0, externalNotices.join(","));

	await cm6.load();
	check("显式 load() 后读到手工编辑的值", cm6.data.name === "from-disk");
	check("load() 视为载入、不算变更", externalNotices.length === 0, externalNotices.join(","));

	await cm6.update({ ...cm6.data, name: "from-api" });
	check("程序化 update() 仍按字段通知", externalNotices.includes("name"), externalNotices.join(","));
	check("update() 落盘覆盖手工值", (await readValues(file4)).name === "from-api");
	offExternal();

	/* ---------- 9. 数值输入 (valueType:"number") ---------- */
	console.log("\n[数值输入]");
	const numSchema: ConfigRoot = {
		controls: [
			{ type: "input", id: "port", label: "端口", valueType: "number", min: 1, max: 65535, integer: true, default: 7636 },
			{ type: "input", id: "ratio", label: "比例", valueType: "number", min: 0, max: 1, default: 0.5 },
			{ type: "input", id: "timeout", label: "超时", valueType: "number", min: 5 },
			{ type: "input", id: "label", label: "文本", default: "x" },
		],
	};
	const cmNum = new ConfigManager(numSchema);
	const nd = cmNum.defaults();
	check("数值输入默认值是数字", nd.port === 7636 && nd.ratio === 0.5);
	check("数值输入缺省默认值回落到 min", nd.timeout === 5, String(nd.timeout));

	const numFile = path.join(tmp, "numeric.json");
	const cmNumFile = new ConfigManager(numSchema, numFile);
	await cmNumFile.load();
	await cmNumFile.update({ port: "8080" });
	check("update 把数字字符串规范化为数字", cmNumFile.data.port === 8080, String(cmNumFile.data.port));

	await fs.writeFile(numFile, JSON.stringify({ port: "9000", ratio: "0.25" }));
	const cmNumLoad = new ConfigManager(numSchema, numFile);
	await cmNumLoad.load();
	check("载入时同样规范化数字字符串",
		cmNumLoad.data.port === 9000 && cmNumLoad.data.ratio === 0.25,
		`${String(cmNumLoad.data.port)}/${String(cmNumLoad.data.ratio)}`);

	check("非法数字被 validate 指出",
		cmNumLoad.validate({ ...cmNumLoad.data, port: "abc" }).some((e) => e.message.includes("数字")));
	check("非整数被 validate 指出",
		cmNumLoad.validate({ ...cmNumLoad.data, port: 1.5 }).some((e) => e.message.includes("整数")));
	check("越界被 validate 指出",
		cmNumLoad.validate({ ...cmNumLoad.data, port: 70000 }).some((e) => e.message.includes("不能大于")));
	check("合法数值通过校验", cmNumLoad.validate().length === 0);
	check("普通 input 仍是字符串", typeof cmNumLoad.data.label === "string");
} finally {
	await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
