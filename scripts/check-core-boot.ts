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
 * 只读取仓库数据, 不启动任何 Bot; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
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

const core = new Core({ webui: false, statistics: false });

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
check("空 services/ 的 syncState 无失败", failedIds.length === 0, JSON.stringify(failedIds));

await core.bot.scan(path.join(root, "bots"));
check("Bot 目录可扫描", core.bot.bots.size > 0, [...core.bot.bots.keys()].join(","));

/* Core.close 的顺序: 基础设施最后倒 */

await core.close();
check("close 后 Core 标记为已销毁", core.disposed === true);
check("close 后服务插件全部卸载", core.services.enabledServices.length === 0);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
