/**
 * 服务插件上下文边界检查: ctx 是扁平的, 设施入口是普通包装对象。
 *
 * 这个脚本替代原来的 `CoreAPI` 白名单检查。要验证的契约:
 * - 没有 `core` 这一层嵌套, 也没有 `init` / `close` / `settings` / `internalDB` 入口;
 * - 没有 `_core` 这种 TS private 后门(`#core` 是真私有字段, 运行期取不到);
 * - Core 未就绪时, 调用设施方法抛 StateError, 而不是拿到 null 或已释放的实例;
 * - 包装对象身份稳定, 插件可以安全地 `const u = ctx.user` 存下来;
 * - 白名单外的管理器成员(init / db)在包装对象上根本不存在;
 * - 可选模块: 未启用 WebUI / 统计时对应入口为 null;
 * - Core.close 之后, 已经发出去的包装对象在调用时如实失败。
 *
 * 用法:
 *   npx tsx scripts/check-core-api.ts
 *
 * 全程内存库 + 临时目录, 不碰仓库数据; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite from "better-sqlite3";
import { CommandManager } from "../src/command/manager";
import { Core } from "../src/core";
import { StateError } from "../src/errors/state-error";
import { SessionManager } from "../src/internal/session-manager";
import { UserManager } from "../src/internal/user-manager";
import { UserProfileManager } from "../src/internal/user-profile";
import { PluginExports } from "../src/plugin/exports";
import { ServiceContext } from "../src/plugin/services/context";
import { Service } from "../src/plugin/services/service";
import type { PluginManifest } from "../src/plugin/types";

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

/** 断言一次调用抛出 StateError */
function throwsState(fn: () => unknown): boolean {
	try {
		fn();
		return false;
	} catch (e) {
		return e instanceof StateError;
	}
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-ctx-"));
const core = new Core({ webui: false, statistics: false });
const manifest: PluginManifest = {
	id: "check",
	version: "0.0.0",
	path: tmp,
	main: "index.ts",
};
const ctx = new ServiceContext(new Service({ manifest, core }), new PluginExports(), new CommandManager({}));

/* ---------- 1. 形状: 扁平, 没有后门 ---------- */

console.log("[形状]");
check("没有 core 嵌套", (ctx as any).core === undefined && !("core" in ctx));
check("没有 TS private 的 _core 后门", (ctx as any)._core === undefined && !("_core" in ctx));
check(
	"生命周期入口不在 ctx 上",
	["init", "close", "settings", "internalDB"].every((k) => (ctx as any)[k] === undefined),
);

/* ---------- 2. 设施未就绪: 调用时明确失败 ---------- */

console.log("\n[设施未就绪]");
check("Core 未 init 时调用 ctx.user.find 抛 StateError", throwsState(() => ctx.user.find("test", "u1")));
check("Core 未 init 时调用 ctx.session.query 抛 StateError", throwsState(() => ctx.session.query("x")));
check("Core 未 init 时调用 ctx.profile.get 抛 StateError", throwsState(() => ctx.profile.get("x")));
check("Core 未 init 时 ctx.statistics 为 null", ctx.statistics === null);
check("未启用 WebUI 时 ctx.webui 为 null", ctx.webui === null);

/* ---------- 3. 白名单: 该有的能用, 不该有的不存在 ---------- */

console.log("\n[白名单]");
const db = new sqlite(":memory:");
const um = new UserManager(db);
um.init();
core.user = um;
const sm = new SessionManager(db);
sm.init();
core.session = sm;
const pm = new UserProfileManager(db);
pm.init();
core.profile = pm;

const accountId = ctx.user.get("test", "u1");
check("包装方法可调用", typeof accountId === "string" && accountId.length > 0, String(accountId));
check("getUnion 可用", typeof ctx.user.getUnion(accountId) === "string");
check("session.get 可用", typeof ctx.session.get("test", "group", "g1") === "string");
check("profile.getMany 可用", ctx.profile.getMany([accountId]) instanceof Map);
check(
	"管理器生命周期成员不在包装对象上",
	(ctx.user as any).init === undefined && (ctx.user as any).db === undefined
	&& (ctx.session as any).init === undefined && (ctx.profile as any).init === undefined,
);
check("包装对象身份稳定(可在插件里缓存)", ctx.user === ctx.user && ctx.session === ctx.session);
check("ctx.bots / ctx.services 是只读快照入口", typeof ctx.bots.list === "function" && typeof ctx.services.list === "function");

/* ---------- 4. Core 释放后: 已发出的包装对象如实失败 ---------- */

console.log("\n[Core 释放后]");
await core.close();
check("Core.close 后 ctx.user 调用抛 StateError", throwsState(() => ctx.user.find("test", "u2")));
check("Core.close 后 ctx.statistics 为 null", ctx.statistics === null);
check("Core.close 后 ctx.webui 为 null", ctx.webui === null);

await ctx.dispose();
db.close();
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
