/**
 * 黑白名单服务插件检查: 判定语义、名单存储、管理端点与对外导出。
 *
 * 直接以假上下文调用 `services/filter` 的模块契约, 因此不依赖 Core, 也不碰仓库数据:
 * 数据目录落在系统临时目录里。检查的是"跑起来才知道"的部分:
 * - 判定语义(每层一个模式 all / black / white; 黑名单优先; 白名单只在 white 模式下
 *   参与; 用户与会话各自独立; 全局与 Bot 两层 AND);
 * - 模式与名单的改动立即生效(内存判定层与库同步, 不需要重新装载);
 * - 重启后各层自行装载: 全局层与 **Bot 私有层**都要生效, 而不是等被触碰;
 * - 管理端点的请求/响应形状与错误码(list 带模式, setMode 校验);
 * - 端点确实注册到了 WebUI(路径 / 方法 / 鉴权), 且导出对其它插件可用。
 *
 * 用法:
 *   npx tsx scripts/check-filter-service.ts
 *
 * 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import filterModule from "../services/filter/index";
import type { MessageCreateEvent } from "../src/protocols/event/message";
import type { PluginWebUIRoute } from "../src/plugin/services/apis/webui";

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

/* ---------- 假设施视图: 只实现端点用到的几个方法 ---------- */

let seq = 0;

/** 账号: (平台, 平台ID) -> uuid */
class UserStub {
	byKey = new Map<string, string>();
	byUuid = new Map<string, { id: string; platform: string }>();

	get(platform: string, id: string): string {
		const key = `${platform}\u0000${id}`;
		let uuid = this.byKey.get(key);
		if (!uuid) {
			uuid = `acc-${++seq}`;
			this.byKey.set(key, uuid);
			this.byUuid.set(uuid, { id, platform });
		}
		return uuid;
	}

	queryMany(ids: string[]) {
		const result = new Map<string, { id: string; platform: string }>();
		for (const id of ids) {
			const info = this.byUuid.get(id);
			if (info) result.set(id, info);
		}
		return result;
	}

	query(uuid: string) {
		return this.byUuid.get(uuid) ?? null;
	}
}

/** 会话: (平台, 类型, 平台ID) -> uuid */
class SessionStub {
	byKey = new Map<string, string>();
	byUuid = new Map<string, { id: string; platform: string; type: string }>();

	get(platform: string, type: string, id: string): string {
		const key = `${platform}\u0000${type}\u0000${id}`;
		let uuid = this.byKey.get(key);
		if (!uuid) {
			uuid = `ses-${++seq}`;
			this.byKey.set(key, uuid);
			this.byUuid.set(uuid, { id, platform, type });
		}
		return uuid;
	}

	queryMany(ids: string[]) {
		const result = new Map<string, { id: string; platform: string; type: string }>();
		for (const id of ids) {
			const info = this.byUuid.get(id);
			if (info) result.set(id, info);
		}
		return result;
	}

	query(uuid: string) {
		return this.byUuid.get(uuid) ?? null;
	}
}

class ProfileStub {
	names = new Map<string, string>();
	getMany(ids: string[]) {
		const result = new Map<string, { name: string }>();
		for (const id of ids) {
			const name = this.names.get(id);
			if (name) result.set(id, { name });
		}
		return result;
	}
}

const user = new UserStub();
const session = new SessionStub();
const profile = new ProfileStub();
const bots = { ids: new Set<string>(["bot-a", "bot-b"]), has: (id: string) => bots.ids.has(id) };

/** 捕获插件注册到 WebUI 的端点 */
let registeredRoute: PluginWebUIRoute | null = null;
/** 捕获插件注册的 WebUI 页面 (一级导航 / Bot 详情窗口) */
const registeredPages: any[] = [];
const registeredBotPages: any[] = [];
/** 捕获事件过滤器 */
let eventFilter: ((event: unknown, bot: { id: string }) => boolean) | null = null;
const logs: string[] = [];

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-filter-"));
const pluginDir = path.resolve("services", "filter");

/** ctx.core.webui 的替身: 与真实 WebUIAPI 的三个注册入口同形 */
function createWebUIStub() {
	return {
		register: (route: PluginWebUIRoute) => {
			registeredRoute = route;
			// 注销由服务插件上下文代管(见 scripts/check-service-webui.ts): 插件自己不调它
			return () => { };
		},
		pages: {
			register: (page: any) => {
				registeredPages.push(page);
				return () => { };
			},
		},
		bot: {
			pages: {
				register: (page: any) => {
					registeredBotPages.push(page);
					return () => { };
				},
			},
		},
	};
}

const ctx = {
	path: { data: dataDir, plugin: pluginDir },
	logger: {
		log: (m: string) => { logs.push(String(m)); },
		warn: (m: string) => { logs.push(`WARN ${String(m)}`); },
		error: (m: string) => { logs.push(`ERROR ${String(m)}`); },
	},
	event: {
		filter: (fn: (event: unknown, bot: { id: string }) => boolean) => { eventFilter = fn; },
		observe: () => { /* 本插件不用 */ },
	},
	core: {
		webui: createWebUIStub(),
		user,
		session,
		profile,
		bot: bots,
	},
} as any;

/** 一条消息事件 */
function message(senderId: string, sessionId: string): MessageCreateEvent {
	return {
		type: "message.create",
		time: Date.now(),
		platform: "test",
		messageId: "m1",
		quoteToken: "",
		senderId,
		senderName: "某用户",
		sessionType: "group",
		sessionId,
		text: "hello",
		richContent: [],
	} as MessageCreateEvent;
}

/** 经过插件注册的事件过滤器判断是否放行 */
function allow(event: unknown, botId = "bot-a"): boolean {
	if (!eventFilter) throw new Error("插件没有注册事件过滤器");
	return eventFilter(event, { id: botId });
}

/** 调用插件注册的管理端点 */
function callAPI(body: unknown) {
	if (!registeredRoute) throw new Error("插件没有注册 WebUI 端点");
	return registeredRoute.handler(body);
}

/** 捕获处理器抛出的 { err, code } */
function expectError(run: () => unknown): { err?: string; code?: number } {
	try {
		run();
	} catch (e) {
		return e as { err?: string; code?: number };
	}
	return {};
}

/* ---------- 1. 加载 ---------- */

console.log(`临时数据目录: ${dataDir}\n`);
console.log("-- 加载与接线 --");

filterModule.init(ctx);
const exported = ctx.exports as {
	list(scope: string, botId?: string, targetType?: string): any[];
	mode(scope: string, botId?: string): string;
	setMode(scope: string, botId: string, mode: string): string;
	add(scope: string, botId: string, kind: string, targetType: string, target: string, reason?: string): any;
	remove(id: number): any;
	removeByBot(botId: string): number;
};

check("init 注册了事件过滤器", typeof eventFilter === "function");
check(
	"init 把端点注册到 WebUI(路径/方法/鉴权)",
	registeredRoute?.path === "filter_list" && registeredRoute?.method === "POST" && registeredRoute?.auth === true,
	JSON.stringify(registeredRoute && { path: registeredRoute.path, method: registeredRoute.method, auth: registeredRoute.auth }),
);
check(
	"init 把全局页面注册到活动栏(相对 public/ 的路径 + 排序)",
	registeredPages.length === 1
	&& registeredPages[0].id === "global"
	&& registeredPages[0].module === "global.js"
	&& registeredPages[0].icon === "shield.svg"
	&& registeredPages[0].order === 50,
	JSON.stringify(registeredPages),
);
check(
	"init 把 Bot 私有名单注册为 Bot 详情窗口页面",
	registeredBotPages.length === 1
	&& registeredBotPages[0].id === "filter"
	&& registeredBotPages[0].module === "bot.js"
	&& registeredBotPages[0].order === 30,
	JSON.stringify(registeredBotPages),
);
check(
	"注册的页面模块文件确实在插件 public/ 下",
	await fs.access(path.join(pluginDir, "public", "global.js")).then(() => true, () => false)
	&& await fs.access(path.join(pluginDir, "public", "bot.js")).then(() => true, () => false)
	&& await fs.access(path.join(pluginDir, "public", "filter-view.js")).then(() => true, () => false),
);
check(
	"导出提供 list / mode / setMode / add / remove / removeByBot",
	["list", "mode", "setMode", "add", "remove", "removeByBot"].every(name => typeof (exported as any)[name] === "function"),
);
check("库文件落在插件数据目录", await fs.access(path.join(dataDir, "filter.db")).then(() => true, () => false));

/* ---------- 2. 判定语义 ---------- */

console.log("-- 判定语义 --");

const alice = user.get("test", "alice");
const bob = user.get("test", "bob");
const group = session.get("test", "group", "g1");
const group2 = session.get("test", "group", "g2");

check("空名单全部放行", allow(message(alice, group)) && allow(message(bob, group)));
check("未设置过的层默认是 black 模式", exported.mode("global", "") === "black", exported.mode("global", ""));

/* ---- black 模式(默认): 只有黑名单参与判定 ---- */

exported.add("global", "", "black", "user", alice, "不受欢迎");
check("用户黑名单拦下本人", !allow(message(alice, group)));
check("用户黑名单不影响他人", allow(message(bob, group)));

exported.remove(exported.list("global", "").find(e => e.target === alice)!.id);
check("移除后立即恢复通行(内存判定层已同步)", allow(message(alice, group)));

exported.add("global", "", "white", "user", alice, "");
check("black 模式下白名单不参与判定", allow(message(alice, group)) && allow(message(bob, group)));

exported.add("global", "", "black", "user", alice, "黑优先");
check("black 模式下黑名单照样拦", !allow(message(alice, group)));

// 清空全局名单, 交给后续用例
for (const entry of exported.list("global", "")) exported.remove(entry.id);
check("清空后全部放行", allow(message(alice, group)));

exported.add("global", "", "black", "session", group, "");
check("会话黑名单拦下该会话", !allow(message(alice, group)));
check("会话名单不影响其它会话", allow(message(alice, group2)));
exported.remove(exported.list("global", "").find(e => e.targetType === "session")!.id);

exported.add("global", "", "black", "user", alice, "");
exported.add("global", "", "black", "session", group, "");
check(
	"同层里用户与会话各自独立(任一边命中都拦)",
	!allow(message(alice, group)) && !allow(message(bob, group))
	&& !allow(message(alice, group2)) && allow(message(bob, group2)),
);
for (const entry of exported.list("global", "")) exported.remove(entry.id);

/* ---- white 模式: 白名单参与判定 ---- */

exported.setMode("global", "", "white");
check("setMode 后判定立即改口径", exported.mode("global", "") === "white");

exported.add("global", "", "white", "session", group, "");
check(
	"white 模式下只放行白名单内的会话, 而没配名单的维度不限制",
	allow(message(alice, group)) && allow(message(bob, group)) && !allow(message(alice, group2)),
);

// 白名单为空 = 该维度不限制(而不是把所有人都拦下)
exported.remove(exported.list("global", "").find(e => e.targetType === "session")!.id);
check(
	"white 模式下维度白名单为空时不限制该维度",
	allow(message(alice, group2)) && allow(message(bob, group2)),
);

exported.add("global", "", "black", "user", bob, "黑优先");
check("white 模式下黑名单仍然优先拦截", !allow(message(bob, group)) && allow(message(alice, group)));

/* ---- all 模式: 黑名单与白名单都不参与判定 ---- */

exported.setMode("global", "", "all");
check(
	"all 模式下黑白名单都不参与判定",
	allow(message(bob, group)) && allow(message(bob, group2)) && allow(message(alice, group2)),
);

exported.setMode("global", "", "black");
for (const entry of exported.list("global", "")) exported.remove(entry.id);
check("切回 black 并清空后全部放行", allow(message(alice, group)) && allow(message(bob, group)));

/* ---------- 3. 两层 AND ---------- */

console.log("-- 全局层与 Bot 私有层 --");

const carolId = user.get("test", "carol");

// 全局: white 模式 + 白名单 alice; bot-a: 默认 black 模式 + 黑名单 alice
exported.setMode("global", "", "white");
exported.add("global", "", "white", "user", alice, "");
exported.add("bot", "bot-a", "black", "user", alice, "bot-a 不欢迎");

check("全局白名单放行 + 该 Bot 私有黑名单 → 拦", !allow(message(alice, group), "bot-a"));
check("同一个人的消息在别的 Bot 上仍放行", allow(message(alice, group), "bot-b"));

// 全局层不再限制, 单看 Bot 私有层自己的模式
for (const entry of exported.list("global", "")) exported.remove(entry.id);
exported.setMode("global", "", "black");

exported.add("bot", "bot-a", "white", "user", bob, "");
exported.setMode("bot", "bot-a", "white");
check(
	"Bot 私有层切到 white 后只放行白名单内",
	allow(message(bob, group), "bot-a") && !allow(message(carolId, group), "bot-a"),
);
check("Bot 私有层里黑名单仍然优先", !allow(message(alice, group), "bot-a"));
check("Bot 私有层的模式不外溢到别的 Bot", allow(message(carolId, group), "bot-b") && allow(message(alice, group), "bot-b"));

exported.removeByBot("bot-a");
check(
	"removeByBot 清掉该 Bot 的私有层与它的模式",
	allow(message(carolId, group), "bot-a") && exported.mode("bot", "bot-a") === "black",
);
check("removeByBot 不动全局层(全局为空即全部放行)", allow(message(alice, group), "bot-a") && allow(message(bob, group), "bot-b"));

/* ---------- 4. 只管消息事件 ---------- */

console.log("-- 事件类型 --");

check("非 message.create 事件一律放行", allow({ type: "notice.create", time: Date.now(), platform: "test" }));

/* ---------- 5. 管理端点 ---------- */

console.log("-- 管理端点 (/service/chirucat-filter/api/filter_list) --");

const ctxUser = ctx.core.user as UserStub;
const ctxSession = ctx.core.session as SessionStub;

const added = callAPI({
	action: "add", scope: "global", kind: "black", targetType: "user",
	target: { platform: "test", id: "carol" }, reason: "备注",
}) as { entry: any };

check("add 返回装饰后的条目", added.entry?.kind === "black" && added.entry?.targetType === "user");
check("add 带回平台信息", added.entry?.platform === "test" && added.entry?.platformId === "carol", JSON.stringify(added.entry));

const carol = ctxUser.byKey.get("test\u0000carol")!;
profile.names.set(carol, "卡罗尔");
const listed = callAPI({ action: "list", scope: "global" }) as { entries: any[]; mode: string };
check("list 返回条目并带上昵称", listed.entries.length === 1 && listed.entries[0].name === "卡罗尔", JSON.stringify(listed.entries));
check("list 同时返回该范围的模式", listed.mode === "black", String(listed.mode));
check("端点列出的名单与判定一致", !allow(message(carol, ctxSession.get("test", "group", "g9"))));

const removed = callAPI({ action: "remove", scope: "global", id: listed.entries[0].id });
check("remove 返回 { removed: true }", (removed as any).removed === true);
check("端点移除后立即放行", allow(message(carol, ctxSession.get("test", "group", "g9"))));

// ---- setMode ----
const switched = callAPI({ action: "setMode", scope: "global", mode: "white" }) as { mode: string };
check("setMode 返回落库后的模式", switched.mode === "white", JSON.stringify(switched));
check("setMode 立即影响判定", (callAPI({ action: "list", scope: "global" }) as any).mode === "white");

callAPI({
	action: "add", scope: "global", kind: "white", targetType: "user",
	target: { platform: "test", id: "dave" }, reason: "",
});
const dave = ctxUser.byKey.get("test\u0000dave")!;
const erin = ctxUser.byKey.get("test\u0000erin") ?? ctxUser.get("test", "erin");
check("端点切到 white 后名单按白名单判定", allow(message(dave, ctxSession.get("test", "group", "g9"))) && !allow(message(erin, ctxSession.get("test", "group", "g9"))));

const backToBlack = callAPI({ action: "setMode", scope: "global", mode: "black" }) as { mode: string };
check("切回 black 后白名单条目回到不参与判定", backToBlack.mode === "black" && allow(message(erin, ctxSession.get("test", "group", "g9"))));

callAPI({ action: "setMode", scope: "global", mode: "all" });
const allMode = callAPI({ action: "list", scope: "global" }) as any;
check("all 模式下端点照常可读写", allMode.mode === "all" && allMode.entries.length === 1);

for (const entry of exported.list("global", "")) exported.remove(entry.id);
callAPI({ action: "setMode", scope: "global", mode: "black" });

check(
	"未知 action → 400",
	expectError(() => callAPI({ action: "nope" })).code === 400,
);
check(
	"非法 mode → 400",
	expectError(() => callAPI({ action: "setMode", scope: "global", mode: "grey" })).code === 400,
);
check(
	"setMode 的 scope=bot 缺 botId → 400",
	expectError(() => callAPI({ action: "setMode", scope: "bot", mode: "all" })).code === 400,
);
check(
	"setMode 的 botId 不存在 → 404",
	expectError(() => callAPI({ action: "setMode", scope: "bot", botId: "nobody", mode: "all" })).code === 404,
);
check(
	"非法 scope → 400",
	expectError(() => callAPI({ action: "list", scope: "any" })).code === 400,
);
check(
	"scope=bot 缺 botId → 400",
	expectError(() => callAPI({ action: "list", scope: "bot" })).code === 400,
);
check(
	"botId 不存在 → 404",
	expectError(() => callAPI({ action: "list", scope: "bot", botId: "nobody" })).code === 404,
);
check(
	"非法 kind → 400",
	expectError(() => callAPI({ action: "add", scope: "global", kind: "grey", targetType: "user", target: { platform: "test", id: "x" } })).code === 400,
);
check(
	"私聊类型的会话名单 → 400",
	expectError(() => callAPI({ action: "add", scope: "global", kind: "black", targetType: "session", target: { platform: "test", id: "p1", type: "private" } })).code === 400,
);
check(
	"remove 不存在的 id → 404",
	expectError(() => callAPI({ action: "remove", scope: "global", id: 99999 })).code === 404,
);
check(
	"remove 的 id 非整数 → 400",
	expectError(() => callAPI({ action: "remove", scope: "global", id: "1" })).code === 400,
);

// 会话名单: 用平台会话 ID 取或建会话, 并带上会话类型
const sessionAdd = callAPI({
	action: "add", scope: "bot", botId: "bot-a", kind: "white", targetType: "session",
	target: { platform: "test", id: "g42", type: "group" }, reason: "",
}) as { entry: any };
check(
	"会话名单带回会话类型",
	sessionAdd.entry?.targetType === "session" && sessionAdd.entry?.sessionType === "group" && sessionAdd.entry?.name === "",
	JSON.stringify(sessionAdd.entry),
);
exported.removeByBot("bot-a");

/* ---------- 6. 持久化与卸载 ---------- */

console.log("-- 持久化 / 卸载 --");

// 全局: 黑名单 carol; bot-b: white 模式 + 白名单 bob —— 重启后两层都该自己回来
exported.add("global", "", "black", "user", carol, "重启后还在");
exported.setMode("bot", "bot-b", "white");
exported.add("bot", "bot-b", "white", "user", bob, "");
check(
	"重启前: 全局黑名单与 bot-b 的白名单模式都在生效",
	!allow(message(carol, group)) && allow(message(bob, group), "bot-b") && !allow(message(alice, group), "bot-b"),
);

filterModule.unload(null as any);

check("unload 关闭名单库(端点不再可用)", (() => {
	try {
		callAPI({ action: "list", scope: "global" });
		return false;
	} catch {
		return true;
	}
})());

const reopenCtx = { ...ctx, core: { ...ctx.core, webui: createWebUIStub() } } as any;
filterModule.init(reopenCtx);
const reopened = reopenCtx.exports as typeof exported;
const afterReopen = reopened.list("global", "");
check("重新 init 后全局名单仍在(库已落盘)", afterReopen.some(e => e.target === carol), JSON.stringify(afterReopen.map(e => e.target)));
check(
	"重新 init 后 Bot 私有层自行装载(不用等被触碰)",
	!allow(message(alice, group), "bot-b") && allow(message(bob, group), "bot-b"),
);
check("重新 init 后 Bot 私有模式也回来了", reopened.mode("bot", "bot-b") === "white", reopened.mode("bot", "bot-b"));
check("重新 init 后全局模式是 black", reopened.mode("global", "") === "black", reopened.mode("global", ""));

filterModule.unload(null as any);
filterModule.unload(null as any);
check("unload 幂等", true);

await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
