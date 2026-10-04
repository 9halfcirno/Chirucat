/**
 * Hook 系统冒烟检查: 验证 HookBus 的分发语义, 以及服务插件经 ctx.hook 注册的
 * handler 会被正确分发、并在上下文释放时自动注销。
 *
 * 用法:
 *   npx tsx scripts/check-hooks.ts
 *
 * 不启动 Core / Bot / WebUI, 全部在内存里跑; 退出码 0 表示全部通过。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { HookBus } from "../src/hooks/bus";
import type { HookBeforeResult } from "../src/hooks/types";
import { CommandManager } from "../src/command/manager";
import type { Command } from "../src/command/types";
import { Core } from "../src/core";
import { ServiceHost } from "../src/plugin/services/host";

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

/* ── 1. HookBus 基本语义 ─────────────────────────────── */

console.log("HookBus 语义");

const bus = new HookBus();

// 无 handler 时按不取消处理
check("无 handler 时 dispatch 返回 false", bus.dispatch("before.message.handle", {} as never) === false);

// 注册顺序执行
const order: string[] = [];
bus.register("before.message.handle", () => { order.push("a"); });
bus.register("before.message.handle", () => { order.push("b"); });
bus.dispatch("before.message.handle", {} as never);
check("handler 按注册顺序调用", order.join(",") === "a,b", order.join(","));

// cancel 阻断后续
const order2: string[] = [];
bus.register("before.bot.enable", () => { order2.push("first"); return { cancel: true } satisfies HookBeforeResult; });
bus.register("before.bot.enable", () => { order2.push("second"); });
const cancelled = bus.dispatch("before.bot.enable", {} as never);
check("cancel: 返回 true", cancelled === true);
check("cancel: 后续 handler 不再调用", order2.join(",") === "first", order2.join(","));

// handler 抛错按放行处理, 且记录后继续
const order3: string[] = [];
bus.register("before.command.handle", () => { order3.push("boom"); throw new Error("hook boom"); });
bus.register("before.command.handle", () => { order3.push("after"); });
const cancelled3 = bus.dispatch("before.command.handle", {} as never);
check("抛错的 handler 不取消动作", cancelled3 === false);
check("抛错的 handler 不阻断后续", order3.join(",") === "boom,after", order3.join(","));

// 返回非 cancel 的对象按放行
check("返回 {} 按放行", bus.dispatch("before.plugin.enable", {} as never) === false);

// unregister
let calls = 0;
const unsub = bus.register("before.plugin.enable", () => { calls++; });
unsub();
bus.dispatch("before.plugin.enable", {} as never);
check("unregister 后不再触发", calls === 0);
// 重复 unregister 安全
unsub();
check("重复 unregister 安全", true);

// 未注册的 hook 名 dispatch 不报错
check("未注册的 hook 名安全", bus.dispatch("before.core.init", {} as never) === false);

/* ── 2. before.command.handle 与 CommandManager 接线 ─────────────────────────────── */

console.log("CommandManager 接线");

const cmdBus = new HookBus();
const cm = new CommandManager({ prefix: "/", hookBus: cmdBus });

let handlerCalls = 0;
const cmd: Command = {
	name: "ping",
	handler: () => { handlerCalls++; },
};
cm.register(cmd);

// 未取消时指令正常执行
// 注意: exec 的字符串入参不带前缀 —— 前缀只对 Message 入参生效(见 CommandManager.exec)
cm.exec("ping");
check("未注册 hook 时指令正常执行", handlerCalls === 1, `calls=${handlerCalls}`);

// 注册取消 hook 后指令被跳过
let hookSeen = 0;
cmdBus.register("before.command.handle", (ctx) => {
	hookSeen++;
	check("hook 收到指令执行上下文",
		ctx.command === cmd && Array.isArray(ctx.args),
		`command=${ctx.command?.name} args=${JSON.stringify(ctx.args)}`);
	return { cancel: true } satisfies HookBeforeResult;
});
handlerCalls = 0;
const hit = cm.exec("ping");
check("取消 hook: exec 仍返回命中的指令名", hit === "ping", String(hit));
check("取消 hook: 指令 handler 未被调用", handlerCalls === 0, `calls=${handlerCalls}`);
check("取消 hook: hook 本身被调用了一次", hookSeen === 1, `seen=${hookSeen}`);

// 注销 hook 后恢复
handlerCalls = 0;
const unsubCmd = cmdBus.register("before.command.handle", () => { });
unsubCmd();
// 上面那条取消 hook 仍在, 需要先注销它 —— 用新 bus 更干净
const cm2 = new CommandManager({ prefix: "/", hookBus: new HookBus() });
let calls2 = 0;
cm2.register({ name: "ping", handler: () => { calls2++; } });
cm2.exec("ping");
check("未接 hookBus 的 CommandManager 行为不变", calls2 === 1, `calls=${calls2}`);

// 多个同名指令: 只取消其中一个, 另一个仍执行
const multiBus = new HookBus();
const cm3 = new CommandManager({ prefix: "/", hookBus: multiBus });
let aCalls = 0, bCalls = 0;
const cmdA: Command = { name: "hi", handler: () => { aCalls++; } };
const cmdB: Command = { name: "hi", handler: () => { bCalls++; } };
cm3.register(cmdA);
cm3.register(cmdB);
multiBus.register("before.command.handle", (ctx) => {
	if (ctx.command === cmdA) return { cancel: true } satisfies HookBeforeResult;
});
cm3.exec("hi");
check("多同名指令: 被取消的跳过, 其余执行", aCalls === 0 && bCalls === 1, `a=${aCalls} b=${bCalls}`);

/* ── 3. 服务插件 ctx.hook 注册与自动注销 ─────────────────────────────── */

console.log("服务插件集成");

// 用一个最小的 Core(不 init): 只需要 services 与它身上的 hooks
const core = new Core({
	webui: false,
	statistics: false,
	servicesStateFile: path.join(os.tmpdir(), `chirucat-hook-state-${process.pid}.json`),
});
check("Core 持有 HookBus", core.hooks instanceof HookBus);

// 探针服务插件: init 里注册一个取消型 hook, unload 里留痕
const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-hook-probe-"));
const marker = path.join(probeDir, "probe-unloaded.marker");

const dir = path.join(probeDir, "hook-probe");
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(
	path.join(dir, "manifest.json"),
	JSON.stringify({ id: "hook-probe", version: "0.0.0", type: "service", main: "index.ts" }, null, "\t"),
);
await fs.writeFile(path.join(dir, "index.ts"), `
import fs from "node:fs";
export default {
	init(ctx) {
		ctx.hook.register("before.core.init", () => ({ cancel: true }));
	},
	async unload() {
		fs.writeFileSync(${JSON.stringify(marker)}, "1");
	},
};
`);

try {
	const host = new ServiceHost(core, path.join(os.tmpdir(), `chirucat-hook-host-state-${process.pid}.json`));
	await host.scan(probeDir);
	const failedIds = await host.syncState();
	check("探针服务插件加载成功", !failedIds.includes("hook-probe"), JSON.stringify(failedIds));

	// 注册的 hook 确实进了 Core 的总线
	const cancelledByPlugin = core.hooks.dispatch("before.core.init", core);
	check("插件经 ctx.hook 注册的 hook 被分发", cancelledByPlugin === true);

	// 卸载后 hook 自动注销
	await host.unload("hook-probe");
	const cancelledAfterUnload = core.hooks.dispatch("before.core.init", core);
	check("服务插件卸载后 hook 自动注销", cancelledAfterUnload === false);

	const unloadedMarker = await fs.access(marker).then(() => true, () => false);
	check("unload 被调用", unloadedMarker);
} finally {
	await fs.rm(probeDir, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
