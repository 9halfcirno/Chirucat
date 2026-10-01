/**
 * Core 接线检查: 验证服务插件层挂到 Core 上的方式, 以及关闭顺序。
 *
 * 刻意不调用 `Core.init()`: bots/chirucat/state.json 的 enable 为 true, 完整启动会
 * 真的拉起 Bot 与它的全部插件(含联网插件), 那超出了"检查接线"的范围。这里只跑
 * init 中与本改动相关的三件事 —— 服务层先于 Bot 就绪、Bot 目录可扫描、close 时
 * 服务层最后卸载。
 *
 * 用法:
 *   npx tsx scripts/check-core-boot.ts
 *
 * 数据方面只读仓库现有数据, 但服务插件会按自己的需要落盘(例如 chirucat-filter 会
 * 在 data/services/chirucat-filter/ 下建库): 那是插件自己的数据目录, 与这里检的
 * 接线无关。不启动任何 Bot; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core";
import { ServiceHost } from "../src/plugin/services/host";
import { root } from "../src/utils/root";

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

const core = new Core({
	webui: false,
	statistics: false,
	// 状态文件指到临时目录: 这个检查不该碰 configs/services/state.json
	servicesStateFile: path.join(os.tmpdir(), `chirucat-core-state-${process.pid}.json`),
});

check("Core 上挂载 ServiceHost", core.services instanceof ServiceHost);
check("webui: false 时不创建 WebUI", core.webui === null);

/* Core.init 的顺序: 服务层先于 Bot 就绪 */

await core.services.scan();
// 断言注册表与 services/ 下实际的服务插件目录一致, 而不是写死为 0:
// 后者在服务插件(such as bind)落地后就会永久失败, 一条永远红的门禁等于没有门禁
const serviceDirCount = await fs.readdir(path.join(root, "services"), { withFileTypes: true })
	.then((entries) => entries.filter((entry) => entry.isDirectory()).length)
	.catch(() => 0);
check("services/ 可扫描", core.services.registry.size === serviceDirCount,
	`registry=${core.services.registry.size} dirs=${serviceDirCount}`);

const failedIds = await core.services.syncState();

// 本检查刻意不 init Core, 而服务插件会依赖 Core 的设施(bind 需要 core.user):
// 这些设施此时为空, 插件必然加载失败 —— 这是“只跑接线”的必然结果, 不是接线缺陷,
// 因此不断言“全部加载成功”(那会让门禁依赖服务插件的具体依赖面)。
// 这里只验证收敛流程本身: 失败逐项上报, 且插件回到关态而不是卡在切换中。
const stuck = [...core.services.registry.values()]
	.filter(service => service.status === "loading" || service.status === "unloading");
check("services/ 可收敛, 加载失败后不卡在切换中", stuck.length === 0,
	`failed=${JSON.stringify(failedIds)} stuck=${stuck.map(s => `${s.id}:${s.status}`).join(",")}`);
if (failedIds.length) {
	console.log(`        未加载: ${failedIds.join(", ")} (Core 未 init, 依赖其设施的服务插件起不来)`);
}

// 过滤服务是名单判定的基础设施: 它的 init 不该碰 Core 的设施(名单判定发生在事件传播
// 阶段, 与 Bot 启停、用户/会话设施无关), 因此在 Core 未 init 时也应该起得来。
// 目录可能被用户删掉, 因此只在它存在时断言。
const filterService = core.services.registry.get("chirucat-filter");
if (filterService) {
	check(
		"chirucat-filter 不依赖 Core 设施即可加载",
		filterService.status === "enabled",
		`status=${filterService.status}`,
	);
}

// 光允许失败不行: 那样服务层的加载/收敛彻底壤掉也是绿的。这里另起一个临时目录:
// - probe: 不依赖 Core 设施的插件, 其 init 写一个哨兵文件 —— 既证明“加载成功”,
//   也证明 init 真的被调用过(而不是只被标成 enabled);
// - probe-fail: init 必抛错的插件 —— 证明失败确实被逐项上报, 而不是被吞掉。
const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-core-probe-"));
const marker = path.join(probeDir, "probe-inited.marker");

/** 在探针目录下写一个临时服务插件 */
async function makeProbeService(id: string, source: string): Promise<void> {
	const dir = path.join(probeDir, id);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "manifest.json"),
		JSON.stringify({ id, version: "0.0.0", type: "service", main: "index.ts" }, null, "\t"),
	);
	await fs.writeFile(path.join(dir, "index.ts"), source);
}

try {
	// 哨兵路径用 JSON 转义后内联: Windows 路径里的反斜杠直接拼进源码会把它打断
	await makeProbeService("probe", `
import fs from "node:fs";
export default { init() { fs.writeFileSync(${JSON.stringify(marker)}, "1"); } };
`);
	await makeProbeService("probe-fail", `
export default { init() { throw new Error("probe init boom"); } };
`);

	await core.services.scan(probeDir);
	const probeFailed = await core.services.syncState();

	const inited = await fs.access(marker).then(() => true, () => false);
	check(
		"不依赖 Core 设施的服务插件可加载, 且 init 真被调用",
		inited && core.services.enabledServices.some(service => service.id === "probe"),
		`inited=${inited} enabled=${core.services.enabledServices.map(s => s.id).join(",")}`,
	);
	check(
		"加载失败的服务插件被逐项上报",
		probeFailed.includes("probe-fail") && !probeFailed.includes("probe"),
		`failed=${JSON.stringify(probeFailed)}`,
	);
} finally {
	await fs.rm(probeDir, { recursive: true, force: true });
}

await core.bot.scan(path.join(root, "bots"));
check("Bot 目录可扫描", core.bot.bots.size > 0, [...core.bot.bots.keys()].join(","));

/* Core.close 的顺序: 基础设施最后倒 */

await core.close();
check("close 后 Core 标记为已销毁", core.disposed === true);
check("close 后服务插件全部卸载", core.services.enabledServices.length === 0);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
