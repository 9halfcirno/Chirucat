/**
 * 服务插件持久化状态检查: 验证 ServiceStateManager 与 ServiceHost 的启停期望态
 * 契约(落盘、重读、依赖连带)。
 *
 * 这里检的都是"跑起来才知道"的行为:
 * - 状态文件不存在(默认) → 全部服务期望启用, 与引入持久化之前的行为一致
 * - 停用一个服务 → 依赖它的服务被连带停用, 两者一起记进停用名单
 * - 重启(新 Core 指向同一状态文件) → 停用状态保持, 服务不会被重新拉起
 * - 启用一个服务 → 它依赖的服务被连带启用, 名单同步清空
 * - 依赖被显式停用时, 期望启用依赖者的请求被拒绝, 且不会改写状态文件
 * - 依赖自身加载失败 / 依赖成环时, 失败不会被写成"用户停用"的期望
 * - 释放(dispose)之后启停/扫描/收敛一律被拒绝, 并发 dispose 等的是同一次释放
 *
 * 用法:
 *   npx tsx scripts/check-service-state.ts
 *
 * 全程在系统临时目录内完成(状态文件也指到临时目录), 不触碰仓库数据;
 * 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core";
import { StateError } from "../src/errors/state-error";

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

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-service-state-"));
const stateFile = path.join(dir, "state.json");

console.log(`临时目录: ${dir}\n`);

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

/** 已启用的服务 id(按注册表顺序) */
function enabledIds(core: Core): string {
	return core.services.enabledServices.map(s => s.id).join(",");
}

/** 状态文件里的停用名单; 文件缺失时为空 */
async function disabledOnDisk(file: string = stateFile): Promise<string[]> {
	try {
		const text = await fs.readFile(file, "utf-8");
		const parsed = JSON.parse(text) as { disabledServices?: unknown };
		return Array.isArray(parsed.disabledServices)
			? parsed.disabledServices.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
}

/* ---------- 准备插件: b 依赖 a ---------- */

await makePlugin(dir, "a", { type: "service", name: "A" }, `
export default {
	init() { globalThis.__calls.push("init-a"); },
	unload() { globalThis.__calls.push("unload-a"); }
};
`);

await makePlugin(dir, "b", { type: "service", name: "B", dependencies: { a: "any" } }, `
export default {
	init() { globalThis.__calls.push("init-b"); },
	unload() { globalThis.__calls.push("unload-b"); }
};
`);

/* ---------- 1. 默认(无状态文件): 全部启用 ---------- */

const core = new Core({ servicesStateFile: stateFile });
await core.services.initState();
await core.services.scan(dir);

check("状态文件缺失时装载出空名单", (await disabledOnDisk()).length === 0);
check("装载状态不会凭空写出文件", !(await fs.stat(stateFile).then(() => true, () => false)));

const failedDefault = await core.services.syncState();
check(
	"默认全部启用(与引入持久化之前一致)",
	failedDefault.length === 0 && enabledIds(core) === "a,b",
	`${JSON.stringify({ failedDefault, enabled: enabledIds(core) })}`,
);

/* ---------- 2. 停用 a: 连带停用依赖它的 b ---------- */

calls.length = 0;
const off = await core.services.setEnabled("a", false);

check("停用 a 后没有服务在运行", off.enabled === false && enabledIds(core) === "", enabledIds(core));
check("依赖 a 的 b 被连带停用", off.affected.includes("b") && !off.affected.includes("a"), off.affected.join(","));
check("卸载钩子被调用", calls.includes("unload-a") && calls.includes("unload-b"), calls.join(","));
check(
	"停用名单落盘(a 与 b)",
	(await disabledOnDisk()).sort().join(",") === "a,b",
	JSON.stringify(await disabledOnDisk()),
);

/* ---------- 3. 重启: 停用状态保持 ---------- */

await core.services.dispose();

const core2 = new Core({ servicesStateFile: stateFile });
await core2.services.initState();
await core2.services.scan(dir);

const failedRestart = await core2.services.syncState();
check(
	"重启后 a/b 仍停用(不会被重新拉起)",
	failedRestart.length === 0 && enabledIds(core2) === "",
	`${JSON.stringify({ failedRestart, enabled: enabledIds(core2) })}`,
);

/* ---------- 4. 启用 b: 连带启用它依赖的 a ---------- */

const on = await core2.services.setEnabled("b", true);

check("启用 b 成功, 依赖 a 一并就绪", on.enabled === true && enabledIds(core2) === "a,b", enabledIds(core2));
check("依赖 a 被连带启用", on.affected.includes("a") && !on.affected.includes("b"), on.affected.join(","));
check("名单被同步清空", (await disabledOnDisk()).length === 0, JSON.stringify(await disabledOnDisk()));

/* ---------- 5. 依赖被停用时拒绝加载依赖者 ---------- */

await core2.services.dispose();

// 手工把文件改成"只停用 a", 此时 b 的期望还是启用 —— 与运行态矛盾
await fs.writeFile(stateFile, JSON.stringify({ disabledServices: ["a"] }, null, 2));

const core3 = new Core({ servicesStateFile: stateFile });
await core3.services.initState();
await core3.services.scan(dir);

const failedBlocked = await core3.services.syncState(["b"]);
check(
	"依赖被停用时跳过依赖者",
	failedBlocked.includes("b") && enabledIds(core3) === "",
	`${JSON.stringify({ failedBlocked, enabled: enabledIds(core3) })}`,
);
check(
	"跳过加载不改写状态文件",
	(await disabledOnDisk()).join(",") === "a",
	JSON.stringify(await disabledOnDisk()),
);

await core3.services.dispose();

/* ---------- 6. 依赖加载失败: 不会被写成永久停用 ---------- */

const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-service-fail-"));
const stateFile2 = path.join(dir2, "state.json");

await makePlugin(dir2, "d", { type: "service", name: "D" }, `
export default { init() { throw new Error("d boom"); } };
`);
await makePlugin(dir2, "e", { type: "service", name: "E", dependencies: { d: "any" } }, `
export default { init() { globalThis.__calls.push("init-e"); } };
`);

const core4 = new Core({ servicesStateFile: stateFile2 });
await core4.services.initState();
await core4.services.scan(dir2);

const failedFail = await core4.services.syncState();
check("依赖链起不来时如实报告", failedFail.includes("d") && failedFail.includes("e"), JSON.stringify(failedFail));
check("启动失败不写成永久停用", (await disabledOnDisk(stateFile2)).length === 0, JSON.stringify(await disabledOnDisk(stateFile2)));

let enableThrew = false;
try {
	await core4.services.setEnabled("e", true);
} catch {
	enableThrew = true;
}
check("启用起不来的服务会失败", enableThrew);
check(
	"失败后名单仍为空(加载失败不等于用户停用)",
	(await disabledOnDisk(stateFile2)).length === 0,
	JSON.stringify(await disabledOnDisk(stateFile2)),
);

await core4.services.dispose();
await fs.rm(dir2, { recursive: true, force: true });

/* ---------- 7. 依赖环: 不会把目标写进停用名单 ---------- */

const dir3 = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-service-cycle-"));
const stateFile3 = path.join(dir3, "state.json");

await makePlugin(dir3, "x", { type: "service", dependencies: { y: "any" } }, `export default { init() {} };`);
await makePlugin(dir3, "y", { type: "service", dependencies: { x: "any" } }, `export default { init() {} };`);

const core5 = new Core({ servicesStateFile: stateFile3 });
await core5.services.initState();
await core5.services.scan(dir3);

let cycleThrew = false;
try {
	await core5.services.setEnabled("x", true);
} catch {
	cycleThrew = true;
}
check("依赖环下启用被拒绝", cycleThrew);
check(
	"依赖环不会把目标写进停用名单",
	(await disabledOnDisk(stateFile3)).length === 0,
	JSON.stringify(await disabledOnDisk(stateFile3)),
);

/* ---------- 8. 释放后的行为 ---------- */

let concurrentDispose = true;
try {
	const first = core5.services.dispose();
	const second = core5.services.dispose();
	await Promise.all([first, second]);
} catch {
	concurrentDispose = false;
}
check("并发/重复 dispose 都能等到卸载完成", concurrentDispose && core5.services.enabledServices.length === 0);

let rejected = 0;
const afterRelease = [
	() => core5.services.setEnabled("x", true),
	() => core5.services.scan(dir3),
	() => core5.services.syncState(),
];
for (const op of afterRelease) {
	try {
		await op();
	} catch (e) {
		if (e instanceof StateError) rejected++;
	}
}
check("释放后启停/扫描/收敛一律拒绝", rejected === afterRelease.length, `${rejected}/${afterRelease.length}`);

await fs.rm(dir3, { recursive: true, force: true });

await fs.rm(dir, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
