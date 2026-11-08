/**
 * DesiredStateStore 自检
 *
 * 状态管理重构第 1 批的验收: 验证基类的策略注入(defaults / normalize / equals)
 * 与三条共通契约, 并确认 Bot 的 opt-in 策略与服务的 opt-out 策略是两份
 * 显式分开的形状, 没有在合并时被揉成同一个布尔开关。
 *
 * 用法:
 *   npx tsx scripts/check-desired-state-store.ts
 *
 * 全程使用系统临时目录; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	DesiredStateStore,
	type DesiredStateStrategy,
} from "../src/config/desired-state-store";
import { botStateStrategy } from "../src/bot/state-manager";
import { serviceStateStrategy } from "../src/plugin/services/state";

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

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
	try {
		await fn();
		return false;
	} catch {
		return true;
	}
}

/** 测试用策略: 名单顺序敏感, 未知键丢弃, 重复项去重 */
type Shape = { ids: string[]; flag: boolean };
const strategy: DesiredStateStrategy<Shape> = {
	defaults: () => ({ ids: [], flag: false }),
	normalize: (raw) => {
		const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const ids = Array.isArray(src.ids)
			? [...new Set(src.ids.filter((v): v is string => typeof v === "string" && !!v))]
			: [];
		return { ids, flag: src.flag === true };
	},
	equals: (a, b) => a.flag === b.flag
		&& a.ids.length === b.ids.length
		&& a.ids.every((id, i) => id === b.ids[i]),
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-desired-state-"));
const file = path.join(tmp, "state.json");
console.log(`临时目录: ${tmp}\n`);

let store: DesiredStateStore<Shape> | null = null;

try {
	/* ---------- 1. 策略注入与默认值 ---------- */
	console.log("[策略注入]");
	store = new DesiredStateStore<Shape>(file, strategy);
	const first = store.get();
	first.ids.push("mutated");
	check("get() 返回副本, 改动不影响内部状态", store.get().ids.length === 0);
	check("构造时采用策略的默认值", store.get().flag === false);

	check("文件缺失时 load 不创建文件",
		await store.load() === false
		&& !(await fs.access(file).then(() => true, () => false)));

	/* ---------- 2. setState 走 normalize ---------- */
	console.log("\n[规范化与落盘]");
	await store.setState({ ids: ["a", "a", "b"], flag: true, junk: 1 } as never);
	check("setState 经 normalize 去重并丢弃未知键",
		store.get().ids.join(",") === "a,b" && store.get().flag === true
		&& !Object.prototype.hasOwnProperty.call(store.get(), "junk"),
		JSON.stringify(store.get()));
	const disk = JSON.parse(await fs.readFile(file, "utf-8")) as Shape;
	check("setState 落盘的是规范化后的值", disk.ids.join(",") === "a,b" && disk.flag === true);
	check("无变化时 load 返回 false", await store.load() === false);

	/* ---------- 3. equals 决定 load 的变更判定 ---------- */
	console.log("\n[变更判定]");
	await fs.writeFile(file, JSON.stringify({ ids: ["a", "b"], flag: true }));
	check("内容相同不报变化", await store.load() === false);
	await fs.writeFile(file, JSON.stringify({ ids: ["b", "a"], flag: true }));
	check("名单顺序不同算变化(equals 顺序敏感)", await store.load() === true);
	check("重读后取到磁盘顺序", store.get().ids.join(",") === "b,a");

	/* ---------- 4. 损坏文件回落默认, 不覆盖原文件 ---------- */
	console.log("\n[损坏容错]");
	const broken = "{ broken";
	await fs.writeFile(file, broken);
	check("损坏文件不抛出(onError: fallback)", !(await rejects(() => store!.load())));
	check("损坏后回落到策略默认值",
		store.get().ids.length === 0 && store.get().flag === false);
	check("回落不覆盖损坏文件", await fs.readFile(file, "utf-8") === broken);
	store.close();
	store.close();
	check("close 幂等", true);

	/* ---------- 5. 两份内置策略显式分离 ---------- */
	console.log("\n[内置策略分离]");
	const bot = botStateStrategy.normalize({
		enable: true, enabledPlugins: ["x"], plugins: { y: true, z: false },
	});
	check("Bot 策略是 opt-in 白名单且兼容旧格式",
		bot.enable === true && bot.enabledPlugins.join(",") === "x,y",
		JSON.stringify(bot));
	check("Bot 策略默认不启用任何插件",
		botStateStrategy.defaults().enable === false
		&& botStateStrategy.defaults().enabledPlugins.length === 0);

	const svc = serviceStateStrategy.normalize({ disabledServices: ["z", "z"] });
	check("服务策略是 opt-out 黑名单且去重",
		svc.disabledServices.join(",") === "z" && !("enable" in svc),
		JSON.stringify(svc));
	check("服务策略默认不停用任何服务",
		serviceStateStrategy.defaults().disabledServices.length === 0);

	check("两个策略不是同一份实现", botStateStrategy !== (serviceStateStrategy as unknown));
	check("各自的 equals 都保持名单顺序敏感",
		botStateStrategy.equals(
			{ enable: true, enabledPlugins: ["a", "b"] },
			{ enable: true, enabledPlugins: ["b", "a"] },
		) === false
		&& serviceStateStrategy.equals(
			{ disabledServices: ["a", "b"] },
			{ disabledServices: ["b", "a"] },
		) === false);
} finally {
	store?.close();
	await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
