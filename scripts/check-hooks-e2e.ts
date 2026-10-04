/**
 * Hook 全链路冒烟检查: 在真实的 Bot.start → 插件加载 → 消息/指令处理链路上
 * 验证 hook 埋点确实被触发, 并能取消动作。
 *
 * 与 check-hooks.ts 的分工: 后者只验 HookBus / CommandManager / 服务插件集成的
 * 单元语义(不启动 Core); 本检查搭一个最小的沙盒 Bot 与插件, 走真实的启动与
 * 消息处理流程, 验证埋点位置接对了。
 *
 * 用法:
 *   npx tsx scripts/check-hooks-e2e.ts
 *
 * 不启 WebUI / 统计 / 真实适配器; 全部在临时沙盒目录里跑; 退出码 0 表示通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core";
import { Message } from "../src/entity/message";
import { HookBus } from "../src/hooks/bus";

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

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-hook-e2e-"));

try {
	/* ── 沙盒服务插件: 注册全部 5 个 hook, 记录轨迹 ─────────────────────── */

	const servicesDir = path.join(sandbox, "services");
	const pluginDir = path.join(servicesDir, "tracer");
	await fs.mkdir(pluginDir, { recursive: true });
	await fs.writeFile(
		path.join(pluginDir, "manifest.json"),
		JSON.stringify({ id: "tracer", version: "0.0.0", type: "service", main: "index.ts" }, null, "\t"),
	);
	const traceFile = path.join(sandbox, "trace.log");
	await fs.writeFile(path.join(pluginDir, "index.ts"), `
const G = globalThis;
G.__hookTrace = G.__hookTrace || [];
const T = (line) => { G.__hookTrace.push(line); };

export default {
	init(ctx) {
		ctx.hook.register("before.bot.enable", (bot) => T("bot:" + bot.id));
		ctx.hook.register("before.plugin.enable", (p) => T("plugin:" + p.id));

		// 取消型: 拦掉文本为 BLOCKED 的消息
		ctx.hook.register("before.message.handle", (msg) => {
			T("message:" + msg.text);
			if (msg.text === "BLOCKED") return { cancel: true };
		});

		// 取消型: 拦掉 forbidden 指令
		ctx.hook.register("before.command.handle", ({ command, message }) => {
			T("command:" + command.name + ":" + (message?.text ?? "<text-only>"));
			if (command.name === "forbidden") return { cancel: true };
		});
	},
};
`);

	const readTrace = async (): Promise<string[]> => {
		const g = globalThis as unknown as { __hookTrace?: string[] };
		return [...(g.__hookTrace ?? [])];
	};

	/* ── 最小 Core: 只装配埋点需要的设施 ─────────────────────── */

	const core = new Core({ webui: false, statistics: false });
	check("Core 持有 HookBus", core.hooks instanceof HookBus);

	// before.core.init 在 init() 入口最先分发, 可被取消: 单独验它, 不跑完整 init
	// (完整 init 会连真实 bots 目录与适配器)
	const unsubCore = core.hooks.register("before.core.init", () => ({ cancel: true }));
	let cancelledByHook = false;
	try {
		await core.init();
	} catch (e) {
		cancelledByHook = e instanceof Error && /Hook/.test(e.message);
	}
	check("before.core.init 可取消 init", cancelledByHook);
	unsubCore();
	check("注销 before.core.init 后 init 不再被取消", core.hooks.dispatch("before.core.init", core) === false);

	/* ── 先加载沙盒服务插件: 它注册的 hook 才能拦在 Bot 启动之前 ─────────────────────── */

	// 服务插件不依赖 Core 的 DB 设施(只用 ctx.hook), 因此 Core 未 init 也能起来
	await core.services.scan(servicesDir);
	const svcFailed = await core.services.syncState();
	check("沙盒服务插件加载成功", !svcFailed.includes("tracer"), JSON.stringify(svcFailed));
	check("服务插件经 ctx.hook 注册成功", core.hooks.dispatch("before.core.init", core) === false);

	/* ── 手动搭一个沙盒 Bot 并启动它(不经过 BotManager 的 bots 目录) ─────────────────────── */

	const botDir = path.join(sandbox, "probe-bot");
	await fs.mkdir(botDir, { recursive: true });
	await fs.writeFile(
		path.join(botDir, "config.json"),
		JSON.stringify({ id: "probe-bot", name: "Probe" }, null, "\t"),
	);
	// state: 启用一个普通插件, 用于验证 before.plugin.enable
	await fs.mkdir(path.join(botDir, "plugins"), { recursive: true });
	const subPluginDir = path.join(botDir, "plugins", "sub");
	await fs.mkdir(subPluginDir, { recursive: true });
	await fs.writeFile(
		path.join(subPluginDir, "manifest.json"),
		JSON.stringify({ id: "sub", version: "0.0.0", main: "index.ts" }, null, "\t"),
	);
	await fs.writeFile(path.join(subPluginDir, "index.ts"), `export default { init() {} };`);
	await fs.writeFile(
		path.join(botDir, "state.json"),
		JSON.stringify({ enable: true, enabledPlugins: ["sub"] }, null, "\t"),
	);

	const { Bot } = await import("../src/bot/bot");
	const bot = new Bot({ id: "probe-bot", name: "Probe", path: botDir }, core);
	await bot.initState();

	// 注册两个指令用于验证 before.command.handle
	let forbiddenCalled = false;
	let okCalled = false;
	bot.command.register({ name: "forbidden", handler: () => { forbiddenCalled = true; } });
	bot.command.register({ name: "ok", handler: () => { okCalled = true; } });

	/* ── 1) before.bot.enable: 沙盒服务插件已注册 hook ─────────────────────── */

	await bot.start();
	check("before.bot.enable 未取消时 Bot 正常启动", bot.running === true);

	const traceAfterStart = await readTrace();
	check("before.bot.enable 被触发", traceAfterStart.some((l) => l === "bot:probe-bot"), traceAfterStart.join(","));
	check("before.plugin.enable 被触发", traceAfterStart.some((l) => l === "plugin:sub"), traceAfterStart.join(","));

	/* ── 2) before.plugin.enable 取消语义 ─────────────────────── */

	const unsubPlugin = core.hooks.register("before.plugin.enable", (p) => {
		if (p.id === "sub") return { cancel: true };
	});
	// 重新加载 sub: 应被取消, 且插件回到关态
	await bot.plugin.unload("sub");
	let loadThrew = false;
	try {
		await bot.plugin.load("sub");
	} catch (e) {
		loadThrew = e instanceof Error && /Hook/.test(e.message);
	}
	check("before.plugin.enable 取消后 load 抛错", loadThrew);
	check("被取消的插件回到关态", bot.plugin.resolve("sub")?.status !== "enabled");
	check("被取消的插件没有运行上下文", bot.plugin.resolve("sub")?.context === null);
	unsubPlugin();

	/* ── 2) before.bot.enable 取消语义 ─────────────────────── */

	// 已启动的 Bot 无法再测取消(幂等直接 return), 用一个新 Bot 验证
	const bot2Dir = path.join(sandbox, "probe-bot-2");
	await fs.mkdir(bot2Dir, { recursive: true });
	await fs.writeFile(path.join(bot2Dir, "config.json"), JSON.stringify({ id: "probe-bot-2" }));
	await fs.writeFile(path.join(bot2Dir, "state.json"), JSON.stringify({ enable: true, enabledPlugins: [] }));
	const bot2 = new Bot({ id: "probe-bot-2", path: bot2Dir }, core);
	await bot2.initState();

	// 已加载的 tracer 插件注册的 hook 在同一个 HookBus 上, 直接给它加一个取消型
	const unsubBot = core.hooks.register("before.bot.enable", (b) => {
		if (b.id === "probe-bot-2") return { cancel: true };
	});
	await bot2.start();
	check("before.bot.enable 取消后 Bot 未启动", bot2.running === false);
	check("before.bot.enable 取消后不扫插件", !bot2.plugin.botPlugins.has("tracer") && !bot2.plugin.globalPlugins.has("tracer"));
	unsubBot();

	/* ── 3) before.message.handle / before.command.handle 取消语义 ─────────────────────── */

	const mkMessage = (text: string): Message => new Message({
		type: "message.create",
		time: Date.now(),
		platform: "probe",
		messageId: "m" + Math.random().toString(36).slice(2),
		quoteToken: "t",
		senderId: "u1",
		senderName: "U",
		sessionType: "private",
		sessionId: "s1",
		text,
		richContent: [{ type: "text", text }],
	}, { adapter: "probe", bot: "probe-bot" }, bot);

	// BLOCKED 消息: 走 MessageHandler.handle, 应整条短路 —— 指令不会被执行
	bot.message.handle(mkMessage("BLOCKED"));
	check("BLOCKED 消息被 before.message.handle 短路", forbiddenCalled === false);

	// 直接走 CommandManager: 未取消的指令正常跑
	bot.command.exec(mkMessage("/ok"));
	check("未取消的指令正常执行", okCalled === true, `called=${okCalled}`);

	// forbidden 指令: 被 before.command.handle 取消
	forbiddenCalled = false;
	bot.command.exec(mkMessage("/forbidden"));
	check("forbidden 指令被 before.command.handle 取消", forbiddenCalled === false);

	// 纯文本触发: message 为 null, hook 也能拿到
	let nullMsgSeen = false;
	const unsubNull = core.hooks.register("before.command.handle", ({ message }) => {
		if (message === null) nullMsgSeen = true;
	});
	bot.command.exec("ok", []);
	check("纯文本触发时 hook 收到 message=null", nullMsgSeen === true);
	unsubNull();

	/* ── 4) 轨迹核对 ─────────────────────── */

	const trace = await readTrace();
	check("before.message.handle 被触发", trace.some((l) => l.startsWith("message:")), trace.join(","));
	check("before.command.handle 被触发", trace.some((l) => l.startsWith("command:")), trace.join(","));

	await bot.stop();
	await bot2.dispose();
} finally {
	await fs.rm(sandbox, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
