/**
 * CoreAPI 边界检查: 服务插件拿到的 `ctx.core` 只提供安全接口。
 *
 * 类型收窄(tsc)管不到运行期, 这里直接验证"未列入白名单的成员拿不到":
 * - Core 未 init / 已 close 时, 数据设施抛 StateError, 而不是交出已释放的实例;
 * - 白名单方法可用(`this` 绑定正确), 未列入的(init / db / record / close 等)读取为 undefined;
 * - 未启用 WebUI、未开启统计时对应入口为 null。
 *
 * 用法:
 *   npx tsx scripts/check-core-api.ts
 *
 * 全程内存库 + 默认配置, 不碰仓库数据; 退出码 0 表示全部通过。
 */
import sqlite from "better-sqlite3";
import { Core } from "../src/core";
import { StateError } from "../src/errors/state-error";
import { UserManager } from "../src/internal/user-manager";
import { CoreAPI } from "../src/plugin/services/apis/core";

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
const api = new CoreAPI(core);

/* ---------- 1. 设施未就绪: 明确失败, 而不是给 null ---------- */

let threw = false;
try { void api.user; } catch (e) { threw = e instanceof StateError; }
check("Core 未 init 时访问 user 抛 StateError", threw);

/* ---------- 2. 白名单: 该有的能用, 不该有的拿不到 ---------- */

const db = new sqlite(":memory:");
const um = new UserManager(db);
um.init();
core.user = um;

const accountId = api.user.get("test", "u1");
check("白名单方法可调用且 this 绑定正确", typeof accountId === "string" && accountId.length > 0, String(accountId));
check("getUnion 可用", typeof api.user.getUnion(accountId) === "string");
check(
	"未列入白名单的成员读取为 undefined",
	(api.user as any).init === undefined && (api.user as any).db === undefined,
	`init=${typeof (api.user as any).init} db=${typeof (api.user as any).db}`,
);

/* ---------- 3. 可选模块: 未启用时为 null ---------- */

check("statistics 未开启时为 null", api.statistics === null);
check("未启用 WebUI 时为 null", api.webui === null);
check("bot / service 视图存在", Boolean(api.bot) && Boolean(api.service));

/* ---------- 4. Core 释放后: 不再交出已失效的实例 ---------- */

await core.close();
let afterClose = false;
try { void api.user; } catch (e) { afterClose = e instanceof StateError; }
check("Core.close 后访问 user 抛 StateError", afterClose);
check("Core.close 后 statistics 为 null", api.statistics === null);

db.close();
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
