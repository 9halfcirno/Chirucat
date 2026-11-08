/**
 * 设置基础设施自检
 *
 * 覆盖: schema 校验 → 默认值 → patch 校验/规范化 → 落盘回读 →
 * 敏感字段脱敏 → 热应用钩子 → 并发写 → 值文件容错,
 * 以及 ConfigManager 改用共享存储后的回归。
 *
 * 用法:
 *   npx tsx scripts/check-settings.ts
 *
 * 全程使用系统临时目录, 不触碰仓库里的 configs/; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { ConfigManager } from "../src/config/manager";
import { defaultsOf, sanitizeLoaded } from "../src/config/schema";
import { JsonFileStore } from "../src/config/store";
import type { ConfigRoot } from "../src/config/types";
import { webuiSettings, type WebUISettings } from "../src/config/settings/domains/webui";
import { SettingsManager } from "../src/config/settings/manager";
import Logger, { defaultLogStream, getLogLevel, setLogLevel } from "../src/utils/logger";

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

/** 断言同步抛错, 且消息包含片段 */
function throws(fn: () => unknown, fragment: string): boolean {
	try {
		fn();
		return false;
	} catch (e) {
		return e instanceof Error && e.message.includes(fragment);
	}
}

/** 断言异步抛错, 且消息包含片段 */
async function rejects(fn: () => Promise<unknown>, fragment: string): Promise<boolean> {
	try {
		await fn();
		return false;
	} catch (e) {
		return e instanceof Error && e.message.includes(fragment);
	}
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => { setTimeout(resolve, ms); });

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-settings-"));
console.log(`临时目录: ${tmp}\n`);

try {
	/* ---------- schema 校验 ---------- */
	console.log("[schema 校验]");
	let probeSeq = 0;
	const registerProbe = (schema: ConfigRoot) => new SettingsManager().register(`probe-${++probeSeq}`, {
		schema,
		file: path.join(tmp, `probe-${probeSeq}.json`),
	});
	check("合法 schema 可注册",
		registerProbe({ controls: [{ type: "switch", id: "a", label: "A" }] }) !== undefined);
	check("缺 controls 被拒", throws(() => registerProbe({} as ConfigRoot), "缺少 controls"));
	check("空 controls 被拒", throws(() => registerProbe({ controls: [] }), "缺少 controls"));
	check("重复 id 被拒",
		throws(() => registerProbe({
			controls: [
				{ type: "switch", id: "a", label: "A" },
				{ type: "switch", id: "a", label: "B" },
			],
		}), "重复控件"));
	check("group 内重复 id 被拒",
		throws(() => registerProbe({
			controls: [
				{
					type: "group", id: "g", label: "G", controls: [
						{ type: "switch", id: "a", label: "A" },
						{ type: "switch", id: "a", label: "B" },
					],
				},
			],
		}), "重复控件"));
	check("table 被拒",
		throws(() => registerProbe({
			controls: [{ type: "table", id: "t", label: "T", controls: [] }],
		}), "不支持 table"));

	/* ---------- schema 直用 ---------- */
	console.log("\n[schema 直用]");
	const sampleSchema: ConfigRoot = {
		version: "1.0.0",
		controls: [
			{ type: "input", id: "s", label: "字符串" },
			{ type: "input", id: "secret", label: "密码", secret: true },
			{
				type: "group", id: "g", label: "组", controls: [
					{ type: "slider", id: "n", label: "数值", min: 0, max: 10, step: 2, default: 4 },
				],
			},
		],
	};
	const sampleDomain = new SettingsManager().register("sample", {
		schema: sampleSchema,
		file: path.join(tmp, "sample.json"),
	});
	await sampleDomain.load();
	check("read().define 就是 schema 本身", sampleDomain.read().define === sampleSchema);
	check("控件顺序原样交给前端",
		sampleDomain.read().define.controls.map((c) => c.id).join(",") === "s,secret,g");

	/* ---------- 默认值 ---------- */
	console.log("\n[默认值]");
	const defaults = defaultsOf(sampleSchema) as any;
	check("默认值展开成嵌套结构", defaults.g?.n === 4);
	check("数值输入缺省回落到 min",
		(defaultsOf({
			controls: [{ type: "input", id: "n", label: "N", valueType: "number", min: 3 }],
		}) as any).n === 3);
	check("select 默认值原样取用",
		(defaultsOf({
			controls: [{ type: "select", id: "e", label: "E", default: "a", items: [{ label: "A", value: "a" }] }],
		}) as any).e === "a");

	/* ---------- patch: 校验与规范化 ---------- */
	console.log("\n[patch]");
	const file = path.join(tmp, "webui.json");
	const hotChanges: string[][] = [];
	const domain = new SettingsManager().register<WebUISettings>("webui", {
		schema: webuiSettings,
		file,
		apply: (_values, changed) => { hotChanges.push(changed); },
	});

	await domain.load();
	check("文件缺失时按定义生成默认值", (await fs.readFile(file, "utf-8")).includes("7636"));
	check("载入时 apply 收到空改动",
		hotChanges.length === 1 && hotChanges[0].length === 0, JSON.stringify(hotChanges));

	const r1 = await domain.patch({ port: "8000" });
	check("数字字符串被转成数字", domain.get().port === 8000);
	// webui 域的每一项现在都是热生效的 (改监听/改密码都有运行期通路)
	check("webui 域无 restartRequired", r1.restartRequired.length === 0, r1.restartRequired.join(","));
	check("port 变更进入热应用", hotChanges.flat().includes("port"));

	check("未知设置项被拒", await rejects(() => domain.patch({ nonsense: 1 }), "未知的设置项"));
	check("数字越界被拒", await rejects(() => domain.patch({ port: 70000 }), "不能大于"));
	check("非数字被拒", await rejects(() => domain.patch({ port: "abc" }), "必须是数字"));
	check("非整数被拒", await rejects(() => domain.patch({ port: 80.5 }), "必须是整数"));
	check("类型不符被拒", await rejects(() => domain.patch({ host: 123 }), "必须是字符串"));
	check("布尔类型不符被拒",
		await rejects(() => domain.patch({ frontConfig: { enableTestLab: "yes" } }), "必须是布尔值"));
	check("非对象被拒", await rejects(() => domain.patch("nope"), "必须是一个对象"));
	check("空壳未知分组被拒", await rejects(() => domain.patch({ unknownGroup: {} }), "未知的设置项"));
	check("校验失败不落盘", domain.get().port === 8000);

	const r2 = await domain.patch({ frontConfig: { enableTestLab: true } });
	check("hot 字段无 restartRequired", r2.restartRequired.length === 0);
	check("热应用收到 hot 字段", hotChanges.flat().includes("frontConfig.enableTestLab"));
	check("布尔值已落盘", (await fs.readFile(file, "utf-8")).includes("\"enableTestLab\": true"));

	// 兼容旧调用方: patch 也接受点号键
	await domain.patch({ frontConfig: { enableTestLab: false } });
	const dotted = await domain.patch({ "frontConfig.enableTestLab": true });
	check("点号键 patch 与嵌套等价",
		dotted.changed.join(",") === "frontConfig.enableTestLab", dotted.changed.join(","));
	await domain.patch({ frontConfig: { enableTestLab: true } });

	/* ---------- 敏感字段 ---------- */
	console.log("\n[敏感字段]");
	await domain.patch({ password: "s3cret" });
	check("明文只在内存", domain.get().password === "s3cret");
	check("对外读取已脱敏", domain.read().values["password"] === "");

	await domain.patch({ password: "" });
	check("空串表示不修改", domain.get().password === "s3cret");

	await domain.patch({ password: null });
	check("null 表示清除", domain.get().password === "");

	/* ---------- 幂等与回读 ---------- */
	console.log("\n[幂等与回读]");
	const snapshot = await fs.readFile(file, "utf-8");
	const r3 = await domain.patch({ port: 8000 });
	check("无变化时不报改动", r3.changed.length === 0);
	check("无变化时不重写文件", (await fs.readFile(file, "utf-8")) === snapshot);

	const reloaded = new SettingsManager().register<WebUISettings>("webui", {
		schema: webuiSettings,
		file,
	});
	await reloaded.load();
	check("从文件回读一致",
		reloaded.get().port === 8000 && reloaded.get().frontConfig.enableTestLab === true);

	/* ---------- 并发 ---------- */
	console.log("\n[并发]");
	await Promise.all([domain.patch({ port: 8100 }), domain.patch({ host: "0.0.0.0" })]);
	const persisted = JSON.parse(await fs.readFile(file, "utf-8"));
	check("并发 patch 不丢改动",
		persisted.port === 8100 && persisted.host === "0.0.0.0", JSON.stringify(persisted));

	/* ---------- 并发: 首次 load 与 commit ---------- */
	console.log("\n[load 与 commit 竞态]");
	let raceFailures = 0;
	let raceDetail = "";
	for (let i = 0; i < 40; i++) {
		const raceFile = path.join(tmp, `race-${i}.json`);
		const store = new JsonFileStore<Record<string, unknown>>(raceFile, { defaults: () => ({ n: 0 }) });

		const loading = store.load();
		await sleep(i % 5); // 扫过 load 的各个阶段
		await store.commit({ n: 5 });
		await loading;

		const inMemory = store.get() as { n: number };
		const onDisk = JSON.parse(await fs.readFile(raceFile, "utf-8")) as { n: number };
		if (inMemory.n !== 5 || onDisk.n !== 5) {
			raceFailures++;
			raceDetail = `第 ${i} 次: memory=${inMemory.n} disk=${onDisk.n}`;
		}
		store.close();
	}
	check("并发 load/commit 后内存与磁盘一致且不丢改动", raceFailures === 0, raceDetail);

	/* ---------- immutable ---------- */
	console.log("\n[immutable]");
	const imm = new SettingsManager().register("imm", {
		schema: {
			controls: [
				{ type: "input", id: "id", label: "id", default: "a", immutable: true },
				{ type: "input", id: "name", label: "name", default: "" },
			],
		},
		file: path.join(tmp, "imm.json"),
	});
	await imm.load();
	const ri = await imm.patch({ id: "a", name: "x" });
	check("原值重复提交不算改动", ri.changed.join(",") === "name", ri.changed.join(","));
	check("immutable 改动被拒", await rejects(() => imm.patch({ id: "b" }), "不可修改"));

	/* ---------- 热应用失败 ---------- */
	console.log("\n[热应用失败]");
	const failFile = path.join(tmp, "fail.json");
	const failDomain = new SettingsManager().register("fail", {
		schema: webuiSettings,
		file: failFile,
		apply: (_values, changed) => { if (changed.length) throw new Error("模拟热应用失败"); },
	});
	await failDomain.load();
	check("热应用失败会抛出",
		await rejects(() => failDomain.patch({ frontConfig: { enableTestLab: true } }), "热应用失败"));
	check("热应用失败但值已落盘",
		(await fs.readFile(failFile, "utf-8")).includes("\"enableTestLab\": true"));

	/* ---------- 热应用失败的异常不得携带明文 ---------- */
	const failSecretFile = path.join(tmp, "fail-secret.json");
	const failSecretDomain = new SettingsManager().register("fail2", {
		schema: webuiSettings,
		file: failSecretFile,
		apply: (_values, changed) => { if (changed.length) throw new Error("模拟热应用失败"); },
	});
	await failSecretDomain.load();
	// apply 总会抛, 而 password 现在是热生效的 —— 这一行也会抛, 属预期
	try { await failSecretDomain.patch({ password: "CANARY_FIRST" }); } catch { /* 预期 */ }
	try {
		await failSecretDomain.patch({
			password: "CANARY_SECOND",
			frontConfig: { enableTestLab: true },
		});
		check("热应用失败会抛出(secret 用例)", false, "未抛出");
	} catch (e) {
		// 用 inspect 而不是 JSON.stringify: 后者的数组 replacer 会递归过滤嵌套键,
		// 把 outcome.values 里的明文一并滤掉 —— 那样断言就是自欺的
		const dumped = inspect(e, { depth: null });
		const direct = String(
			(e as { outcome?: { values?: Record<string, unknown> } }).outcome?.values?.["password"] ?? "",
		);
		check("异常对象不含明文 secret",
			!dumped.includes("CANARY_FIRST")
			&& !dumped.includes("CANARY_SECOND")
			&& !direct.includes("CANARY_SECOND"),
			dumped.slice(0, 240));
	}

	/* ---------- 值文件容错 ---------- */
	console.log("\n[值文件容错]");
	const dirty = sanitizeLoaded(webuiSettings, { port: "abc", unknown: 1, host: "0.0.0.0" });
	check("未知键被丢弃", !("unknown" in dirty));
	check("非法值回落默认", dirty["port"] === 7636);
	check("合法值保留", dirty["host"] === "0.0.0.0");
	check("缺失键补默认",
		(dirty["frontConfig"] as any)?.enableTestLab === false);

	/* ---------- ConfigManager 回归 ---------- */
	console.log("\n[ConfigManager 回归]");
	const cmFile = path.join(tmp, "plugin-config.json");
	const cm = new ConfigManager({
		controls: [
			{ type: "switch", id: "on", label: "开关", default: false },
			{ type: "slider", id: "n", label: "数值", min: 0, max: 10, step: 1, default: 3 },
		],
	}, cmFile);

	await cm.load();
	check("按默认值生成文件", (await fs.readFile(cmFile, "utf-8")).includes("\"n\": 3"));

	await cm.update({ on: true, n: 7 });
	check("update 生效", cm.get("on") === true && cm.get<number>("n") === 7);
	const reread = JSON.parse(await fs.readFile(cmFile, "utf-8"));
	check("落盘正确", reread.on === true && reread.n === 7);

	await Promise.all([cm.update({ on: false, n: 1 }), cm.update({ on: true, n: 9 })]);
	const after = JSON.parse(await fs.readFile(cmFile, "utf-8"));
	check("并发 update 不交错", after.n === 9 && after.on === true, JSON.stringify(after));
	/* ---------- restart 机制 ---------- */
	// 当前内置域已经没有 restart 项了, 用一份自定义定义锁住机制本身:
	// restart 字段只落盘、不进热应用, 并出现在 restartRequired 里
	console.log("\n[restart 机制]");
	const restartApplied: string[][] = [];
	const restartDomain = new SettingsManager().register("restart-probe", {
		schema: {
			controls: [
				{ type: "slider", id: "slow", label: "slow", min: 0, max: 10, step: 1, default: 1, restart: true },
				{ type: "slider", id: "fast", label: "fast", min: 0, max: 10, step: 1, default: 1 },
			],
		},
		file: path.join(tmp, "restart-probe.json"),
		apply: (_values, changed) => { restartApplied.push(changed); },
	});
	await restartDomain.load();

	const rr = await restartDomain.patch({ slow: 5, fast: 5 });
	check("restart 字段被标出", rr.restartRequired.join(",") === "slow", rr.restartRequired.join(","));
	check("restart 字段不进热应用", restartApplied.flat().join(",") === "fast", restartApplied.flat().join(","));
	check("restart 字段仍然落盘", restartDomain.get().slow === 5);

	/* ---------- 日志级别过滤 ---------- */
	// 只收挑带"自检"字样的条目: 日志流是全局的, 期间可能有其它模块的日志混进来
	console.log("\n[日志级别]");
	const seen: string[] = [];
	const off = defaultLogStream.subscribe((entry) => {
		if (entry.message.includes("自检")) seen.push(entry.level);
	});
	const probe = new Logger("check-settings");

	try {
		setLogLevel("warn");
		check("setLogLevel 生效", getLogLevel() === "warn");
		setLogLevel("nonsense-value");
		check("非法级别被忽略", getLogLevel() === "warn");

		probe.debug("自检: 这条 debug 应被丢弃");
		probe.info("自检: 这条 info 应被丢弃");
		probe.warn("自检: 这条 warn 应可见");
		probe.error("自检: 这条 error 应可见");

		check("低于级别的条目被丢弃",
			seen.join(",") === "warn,error", seen.join(","));
	} finally {
		setLogLevel("debug");
		off();
	}
	check("级别可恢复默认", getLogLevel() === "debug");
} finally {
	await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
