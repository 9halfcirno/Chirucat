import { Core } from "./src/core";
import { Bot } from "./src/bot/bot";
import { Plugin } from "./src/plugin/plugin";
import { PluginContext } from "./src/plugin/contexts/context";
import { MessageHandler } from "./src/bot/message-handler";
import { MessageFilter } from "./src/bot/message-filter";
import type { Message } from "./src/entity/message";
import type { PluginManifest } from "./src/plugin/types";

const mk = (sessionId: string, senderId = "u", text = "hi") => ({ session: { id: sessionId, type: "group" }, sender: { id: senderId, name: senderId }, text }) as unknown as Message;

let failed = 0;
const assert = (name: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}`); if (!cond) failed++; };

// ===== 1. MessageFilter =====
{
	const f = new MessageFilter({ blacklist: ["blocked"], whitelist: ["ok"], rateLimit: { windowMs: 1000, max: 2 } });
	assert("黑名单命中 -> 阻止", f.filter(mk("blocked")) === false);
	assert("白名单外 -> 阻止", f.filter(mk("other")) === false);
	assert("白名单命中 -> 放行(1)", f.filter(mk("ok")) === true);
	assert("白名单命中 -> 放行(2)", f.filter(mk("ok")) === true);
	assert("速率超限 -> 阻止(3)", f.filter(mk("ok")) === false);
}
{
	const f = new MessageFilter({ by: "sender", blacklist: ["baduser"] });
	assert("按 sender 维度黑名单", f.filter(mk("any", "baduser")) === false);
	assert("sender 未黑名单 -> 放行", f.filter(mk("any", "good")) === true);
}

// ===== 2. 插件消息回调链 =====
{
	const core = new Core();
	const bot = new Bot({ id: "t", path: "./bots/t" }, core);
	const manifest: PluginManifest = { id: "p", version: "0.0.0", path: ".", main: "index.js" };
	const ctx = new PluginContext(bot, manifest);

	const hits: string[] = [];
	ctx.message.full("hi", () => hits.push("full"));
	ctx.message.start("hello", () => hits.push("start"));
	ctx.message.regex(/^ping/i, () => hits.push("regex"));
	ctx.message.all(async () => { hits.push("all"); });

	ctx.handleMessage(mk("s", "u", "hi"));
	assert("匹配: full+all", hits.join(",") === "full,all");
	hits.length = 0;

	ctx.handleMessage(mk("s", "u", "ping me"));
	assert("匹配: regex+all", hits.join(",") === "regex,all");
	hits.length = 0;

	ctx.handleMessage(mk("s", "u", "hello world"));
	assert("匹配: start+all", hits.join(",") === "start,all");
	hits.length = 0;

	ctx.handleMessage(mk("s", "u", "nothing"));
	assert("匹配: all only", hits.join(",") === "all");

	// 错误不阻断后续
	ctx.message.match(() => { throw new Error("boom"); }, () => hits.push("never1"));
	ctx.message.match(() => true, () => hits.push("after-error"));
	hits.length = 0;
	ctx.handleMessage(mk("s", "u", "x"));
	assert("回调抛错不阻断后续", hits.includes("after-error") && !hits.includes("never1"));
}

// ===== 3. MessageHandler 接线 (指令未命中 -> 插件回调) =====
{
	const core = new Core();
	const bot = new Bot({ id: "t", path: "./bots/t" }, core);
	const manifest: PluginManifest = { id: "p", version: "0.0.0", path: ".", main: "index.js" };
	const ctx = new PluginContext(bot, manifest);
	const plugin = new Plugin(manifest, null, ctx);
	bot.plugin.plugins.set("p", plugin);

	const hits: string[] = [];
	ctx.message.full("hi", () => hits.push("plugin-cb"));

	const mh = new MessageHandler(bot);
	mh.handle(mk("s", "u", "hi"));
	assert("指令未命中 -> 触发插件回调", hits.join(",") === "plugin-cb");

	bot.command.register({ name: "hi", handler: () => { hits.push("command"); } });
	hits.length = 0;
	mh.handle(mk("s", "u", "/hi"));
	assert("指令命中 -> 不触发插件回调", hits.join(",") === "command");

	// 过滤阻止 (对同一个 handler 加黑名单)
	mh.filter.blacklist.add("s");
	hits.length = 0;
	mh.handle(mk("s", "u", "hi"));
	assert("黑名单阻止整条链路", hits.length === 0);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
