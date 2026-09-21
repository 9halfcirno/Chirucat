/**
 * BotStateManager 行为检查: 验证 state.json 的读写、兼容与监听契约。
 *
 * 这里检的都是"跑起来才知道"的行为, 光读代码确认不了:
 * - 文件缺失 / 损坏时的回退
 * - 旧格式 `{ plugins: {...} }` 的兼容读取
 * - setter 的落盘先于 resolve
 * - 外部改动触发监听, 而自身写入不触发(防回环)
 * - 并发写入不丢更新, 且内存与磁盘一致
 * - close 后不再响应
 *
 * 用法:
 *   npx tsx scripts/check-bot-state.ts
 *
 * 全程在系统临时目录内完成, 不触碰仓库数据; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotStateManager, DEFAULT_BOT_STATE } from "../src/bot/state-manager";
import type { BotState } from "../src/bot/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 监听器收到的一批快照 */
type Snapshots = BotState[];

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

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "botstate-"));
const file = path.join(dir, "state.json");

/** 直接读盘的原始对象: 也用来核对"不该出现的字段" */
async function onDiskRaw(): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
}

/** 直接读盘, 用于核对落盘结果 */
async function onDisk(): Promise<BotState> {
	return await onDiskRaw() as unknown as BotState;
}

console.log(`临时目录: ${dir}\n`);

/* ---------- 1. 文件缺失 ---------- */
{
	const manager = new BotStateManager(file);
	await manager.load();
	check(
		"文件缺失时回退默认状态",
		JSON.stringify(manager.get()) === JSON.stringify(DEFAULT_BOT_STATE),
		JSON.stringify(manager.get()),
	);
	manager.close();
}

/* ---------- 2. 旧格式兼容 ---------- */
{
	await fs.writeFile(file, JSON.stringify({ enable: true, plugins: { ping: true, off: false } }));
	const manager = new BotStateManager(file);
	await manager.load();
	const state = manager.get();
	check(
		"旧格式 plugins 对象被读成启用列表(只取 true)",
		state.enable === true && state.enabledPlugins.length === 1 && state.enabledPlugins[0] === "ping",
		JSON.stringify(state),
	);
	manager.close();
}

/* ---------- 3. 写入: 落盘先于 resolve, 且写回新格式 ---------- */
{
	const manager = new BotStateManager(file);
	await manager.load();

	await manager.setPluginEnabled("abc", true);
	const afterAdd = await onDiskRaw();
	const added = afterAdd.enabledPlugins;
	check(
		"setPluginEnabled 落盘先于 resolve, 且不再写出 plugins 字段",
		Array.isArray(added) && added.includes("abc") && afterAdd.plugins === undefined,
		JSON.stringify(afterAdd),
	);

	await manager.setPluginEnabled("abc", false);
	const afterRemove = await onDisk();
	check("取消启用后从列表移除", afterRemove.enabledPlugins.join(",") === "ping", JSON.stringify(afterRemove));

	await manager.setEnable(false);
	check("setEnable 落盘", (await onDisk()).enable === false);
	manager.close();
}

/* ---------- 4. 损坏文件 ---------- */
{
	await fs.writeFile(file, "{ 这不是合法 json");
	const manager = new BotStateManager(file);
	await manager.load();
	check(
		"损坏文件回退默认状态且不抛错",
		JSON.stringify(manager.get()) === JSON.stringify(DEFAULT_BOT_STATE),
		JSON.stringify(manager.get()),
	);
	manager.close();
}

/* ---------- 5. 监听: 自身写入不回环, 外部改动生效 ---------- */
{
	await fs.writeFile(file, JSON.stringify({ enable: false, enabledPlugins: [] }));
	const manager = new BotStateManager(file);
	await manager.load();
	manager.startWatching();

	const seen: Snapshots = [];
	manager.watch((state) => seen.push(state));

	await manager.setEnable(true);
	await sleep(400);
	check("自身写入不触发监听(防回环)", seen.length === 0, JSON.stringify(seen));

	await fs.writeFile(file, JSON.stringify({ enable: true, enabledPlugins: ["ping"] }));
	await sleep(500);
	const last = seen[seen.length - 1];
	check(
		"外部改动触发监听并读到新内容",
		seen.length >= 1 && !!last && last.enabledPlugins.length === 1 && last.enabledPlugins[0] === "ping",
		JSON.stringify(seen),
	);

	// 旧格式的外部改动同样应被识别
	await fs.writeFile(file, JSON.stringify({ enable: false, plugins: { legacy: true } }));
	await sleep(500);
	const legacyLast = seen[seen.length - 1];
	check(
		"外部写入的旧格式同样生效",
		!!legacyLast && legacyLast.enable === false && legacyLast.enabledPlugins[0] === "legacy",
		JSON.stringify(seen),
	);

	manager.close();
}

/* ---------- 6. 并发写入 ---------- */
{
	const manager = new BotStateManager(file);
	await manager.load();

	await Promise.all([
		manager.setPluginEnabled("a", true),
		manager.setPluginEnabled("b", true),
		manager.setPluginEnabled("c", true),
	]);

	const memory = manager.get();
	const disk = await onDisk();
	const wanted = ["a", "b", "c", "legacy"];
	check("并发写入不丢更新(内存)", wanted.every((id) => memory.enabledPlugins.includes(id)), JSON.stringify(memory));
	check(
		"并发写入后内存与磁盘一致",
		wanted.every((id) => disk.enabledPlugins.includes(id))
			&& disk.enabledPlugins.length === memory.enabledPlugins.length,
		JSON.stringify({ disk, memory }),
	);
	manager.close();
}

/* ---------- 6b. 读盘与写入并发: 读不得吞掉写入 ---------- */
{
	const manager = new BotStateManager(file);
	await manager.load();

	const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
	for (const id of ids) {
		await Promise.all([manager.load(), manager.setPluginEnabled(id, true)]);
	}

	const memory = manager.get();
	const disk = await onDisk();
	check("并发 load 不吞掉写入(内存)", ids.every((id) => memory.enabledPlugins.includes(id)), JSON.stringify(memory));
	check(
		"并发 load 后内存与磁盘仍然一致",
		ids.every((id) => disk.enabledPlugins.includes(id))
			&& disk.enabledPlugins.length === memory.enabledPlugins.length,
		JSON.stringify({ disk, memory }),
	);
	manager.close();
}

/* ---------- 7. close 后静默 ---------- */
{
	const manager = new BotStateManager(file);
	await manager.load();
	manager.startWatching();

	const seen: Snapshots = [];
	manager.watch((state) => seen.push(state));
	manager.close();

	await fs.writeFile(file, JSON.stringify({ enable: false, enabledPlugins: ["after-close"] }));
	await sleep(400);
	check("close 后不再响应外部改动", seen.length === 0, JSON.stringify(seen));
}

/* ---------- 8. 原子写不留临时文件 ---------- */
{
	const entries = await fs.readdir(dir);
	check("原子写不残留 .tmp 文件", entries.every((name) => !name.endsWith(".tmp")), entries.join(", "));
}

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
