/**
 * 服务插件 WebUI 检查: 运行期注册端点、静态资源、鉴权与释放后的行为。
 *
 * 真起一个 `WebUIServer`(端口 0 由系统分配)并打真实 HTTP, 验证的是"跑起来才知道"的部分:
 * - 端点在 `/service/<插件id>/api/<路径>`, 静态资源在 `/service/<插件id>/public`;
 * - 核心 `/api/*` 与插件命名空间互不影响, 插件也不能跨进别人的命名空间;
 * - 默认鉴权(未登录 401), `auth: false` 的端点放行, 静态资源不鉴权;
 * - 上下文注销后端点返回 503(服务未启用)、静态资源回到 404;
 * - 路径/方法/归属 id 非法一律拒绝。
 *
 * 用法:
 *   npx tsx scripts/check-service-webui.ts
 *
 * 全程在临时目录 + 回环地址上完成, 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Core } from "../src/core";
import { CommandManager } from "../src/command/manager";
import { StateError } from "../src/errors/state-error";
import { PluginExports } from "../src/plugin/exports";
import { WebUIAPI } from "../src/plugin/services/apis/webui";
import { ServiceContext } from "../src/plugin/services/context";
import { Service } from "../src/plugin/services/service";
import { WebUIServer } from "../src/webui/server/server";

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

const apiDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-webui-api-"));
const staticDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-webui-static-"));
const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-webui-plugin-"));

// 插件自带的静态资源: services/<id>/public 的替身
const publicDir = path.join(pluginDir, "public");
await fs.mkdir(publicDir, { recursive: true });
await fs.writeFile(path.join(publicDir, "hello.txt"), "hello from plugin", "utf-8");

// 一个核心 API 模块: 证明核心端点与插件命名空间互不干扰, 且核心端点的鉴权照旧
await fs.writeFile(path.join(apiDir, "core_ping.ts"), `
export default {
	path: "core_ping",
	method: "POST",
	auth: false,
	handler: () => ({ core: true })
};
`, "utf-8");
await fs.writeFile(path.join(apiDir, "core_auth.ts"), `
export default {
	path: "core_auth",
	method: "POST",
	auth: true,
	handler: () => ({ core: "authed" })
};
`, "utf-8");

// 页面清单端点直接用仓库里真实的实现(转出去即可): 页面注册表的 HTTP 行为要在真模块上验
const realPagesApi = pathToFileURL(path.resolve(import.meta.dirname, "..", "src", "webui", "server", "api", "get_webui_pages.ts")).href;
await fs.writeFile(path.join(apiDir, "get_webui_pages.ts"), `export { default } from ${JSON.stringify(realPagesApi)};\n`, "utf-8");

const core = new Core({ webui: false, statistics: false });
const server = new WebUIServer({
	port: 0,
	host: "127.0.0.1",
	password: "pw",
	apiDir,
	staticDir,
	core,
});

await server.start();
// Core.init 里就是这么接的: 服务插件的 ctx.core.webui 读的是 Core 上的这个引用
core.webui = server;
const listening = server.listening;
if (!listening) throw new Error("服务器未能监听");
const base = `http://127.0.0.1:${listening.port}`;
console.log(`监听地址: ${base}\n`);

/** 发一个 POST */
function post(url: string, body: unknown, cookie?: string) {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (cookie) headers.Cookie = cookie;
	return fetch(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
}

/** 发一个 GET */
function get(url: string, cookie?: string) {
	const headers: Record<string, string> = {};
	if (cookie) headers.Cookie = cookie;
	return fetch(url, { method: "GET", headers });
}

const disposed: (() => void)[] = [];
const webui = new WebUIAPI(server, "probe", (dispose) => disposed.push(dispose));

/* ---------- 1. 注册与访问 ---------- */

console.log("-- 注册与访问 --");

webui.register({ path: "echo", method: "POST", handler: (body) => ({ got: body }) });
webui.register({ path: "open", method: "POST", auth: false, handler: () => "plain" });
const unmountPublic = server.mountServicePublic("probe", publicDir);

/** 登录并取回 Cookie, 供"已登录"的用例使用 */
const login = await post(`${base}/api/auth/login`, { password: "pw" });
const setCookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
const cookie = setCookies.map(value => value.split(";")[0]).join("; ");

check("登录成功", login.status === 200 && cookie.includes("chirucat_webui_token"), `status=${login.status}`);
check("注册时把注销函数交给了上下文", disposed.length === 2, String(disposed.length));

const unauthorized = await post(`${base}/service/probe/api/echo`, { a: 1 });
check("插件端点默认要求鉴权(未登录 401)", unauthorized.status === 401, `status=${unauthorized.status}`);

const echoed = await post(`${base}/service/probe/api/echo`, { a: 1 }, cookie);
check("已登录可访问插件端点", echoed.status === 200, `status=${echoed.status}`);
check("返回值按 JSON 写出", JSON.stringify(await echoed.json()) === JSON.stringify({ got: { a: 1 } }));

const opened = await post(`${base}/service/probe/api/open`, {});
check("auth: false 的端点无需登录", opened.status === 200, `status=${opened.status}`);
check("字符串返回值原样发送", (await opened.text()) === "plain");

const corePing = await post(`${base}/api/core_ping`, {});
check("核心端点不受影响", corePing.status === 200 && (await corePing.json()).core === true, `status=${corePing.status}`);

const coreAuth = await post(`${base}/api/core_auth`, {});
const coreAuthed = await post(`${base}/api/core_auth`, {}, cookie);
check(
	"核心端点的鉴权语义不变(401 / 已登录 200)",
	coreAuth.status === 401 && coreAuthed.status === 200,
	`unauth=${coreAuth.status} authed=${coreAuthed.status}`,
);

const crossNamespace = await post(`${base}/service/probe/api/core_ping`, {}, cookie);
check("核心端点不会被插件命名空间顶掉", crossNamespace.status === 404, `status=${crossNamespace.status}`);

const unknown = await post(`${base}/service/nobody/api/echo`, {}, cookie);
check("未知插件命名空间为 404", unknown.status === 404, `status=${unknown.status}`);

/* ---------- 2. 自带静态资源 ---------- */

console.log("-- 静态资源 --");

const asset = await fetch(`${base}/service/probe/public/hello.txt`);
check("插件 public 目录挂到 /service/<id>/public", asset.status === 200 && (await asset.text()) === "hello from plugin", `status=${asset.status}`);
check("静态资源与核心前端一样不鉴权", asset.status === 200);

const missing = await fetch(`${base}/service/probe/public/nope.txt`);
check("静态目录里没有的文件为 404", missing.status === 404, `status=${missing.status}`);

/* ---------- 3. 重新注册与注销 ---------- */

console.log("-- 重新注册与注销 --");

const first = webui.register({ path: "again", method: "POST", auth: false, handler: () => ({ v: 1 }) });
const second = webui.register({ path: "again", method: "POST", auth: false, handler: () => ({ v: 2 }) });
first(); // 旧注销不该影响新注册
const again = await post(`${base}/service/probe/api/again`, {});
check("同一路径重新注册只换处理器", again.status === 200 && (await again.json()).v === 2, `status=${again.status}`);

second();
const afterUnregister = await post(`${base}/service/probe/api/again`, {});
check("注销后端点返回 503(而不是消失)", afterUnregister.status === 503, `status=${afterUnregister.status}`);
check(
	"503 里点明是哪个服务未启用",
	(await afterUnregister.json()).err?.includes("probe"),
);

unmountPublic();
const afterUnmount = await fetch(`${base}/service/probe/public/hello.txt`);
check("注销静态目录后回到 404", afterUnmount.status === 404, `status=${afterUnmount.status}`);

// 重新挂载: 服务停用后再次启用是正常路径
const remount = server.mountServicePublic("probe", publicDir);
check("静态目录可重新挂载", (await fetch(`${base}/service/probe/public/hello.txt`)).status === 200);
remount();

/* ---------- 4. 上下文代管 ServiceContext ---------- */

console.log("-- 上下文代管 --");

// 服务插件拿到的 ctx.core.webui 由服务上下文提供: 注册要走通 上下文 -> CoreAPI -> 服务器,
// 注销则由上下文代管(插件自己不记)
const service = new Service({
	manifest: { id: "ctx-probe", version: "0.0.0", main: "index.ts", path: pluginDir },
	core,
});
const serviceContext = new ServiceContext(service, new PluginExports(), new CommandManager({}));

serviceContext.core.webui!.register({ path: "echo", method: "POST", auth: false, handler: () => ({ from: "ctx" }) });
serviceContext.core.webui!.pages.register({
	id: "ctx-page",
	title: "上下文页面",
	module: "page/ctx.js",
	menu: [{ title: "子项", module: "page/ctx.js" }],
});
serviceContext.core.webui!.bot.pages.register({ id: "ctx-bot", title: "上下文 Bot 页面", module: "page/bot.js" });

const viaContext = await post(`${base}/service/ctx-probe/api/echo`, {});
check("经 ctx.core.webui.register 注册的端点可访问", viaContext.status === 200, `status=${viaContext.status}`);
check("插件 public 目录由上下文自动挂载", (await fetch(`${base}/service/ctx-probe/public/hello.txt`)).status === 200);

const ctxPages = await (await get(`${base}/api/get_webui_pages`, cookie)).json();
check(
	"经 ctx.core.webui.pages.register 注册的页面出现在清单里",
	ctxPages.pages.some((p: any) => p.key === "svc-ctx-probe-ctx-page" && p.scope === "app"),
);
check(
	"经 ctx.core.webui.bot.pages.register 注册的页面出现在清单里",
	ctxPages.pages.some((p: any) => p.key === "ctx-probe-ctx-bot" && p.scope === "bot"),
);

serviceContext.dispose();
const afterDispose = await post(`${base}/service/ctx-probe/api/echo`, {});
check("上下文释放后端点返回 503", afterDispose.status === 503, `status=${afterDispose.status}`);
check("上下文释放后静态资源回到 404", (await fetch(`${base}/service/ctx-probe/public/hello.txt`)).status === 404);

// 这就是"停用即注销": 注销函数由上下文代管, 插件自己不记也不会残留
const afterCtxDispose = await (await get(`${base}/api/get_webui_pages`, cookie)).json();
check(
	"上下文释放后它注册的页面从清单消失(停用即注销)",
	!afterCtxDispose.pages.some((p: any) => p.service === "ctx-probe"),
	JSON.stringify(afterCtxDispose.pages.map((p: any) => p.key)),
);

/* ---------- 5. 服务插件页面注册表 ---------- */

console.log("-- 服务插件页面 --");

check("页面清单端点要求鉴权", (await get(`${base}/api/get_webui_pages`)).status === 401);

const before = await (await get(`${base}/api/get_webui_pages`, cookie)).json();
check("上面那些上下文页面注销后清单里没有 app 页面", !before.pages.some((p: any) => p.scope === "app"));

const disposeApp = webui.pages.register({
	id: "global",
	title: "黑白名单",
	icon: "shield.svg",
	order: 50,
	module: "page/global.js",
	styles: ["page/rows.css"],
	menu: [{ title: "全局名单", module: "page/global.js" }],
});
webui.bot.pages.register({ id: "filter", title: "名单", module: "page/bot.js", order: 30 });

const registered = await (await get(`${base}/api/get_webui_pages`, cookie)).json();
const appPage = registered.pages.find((p: any) => p.scope === "app");
const botPage = registered.pages.find((p: any) => p.scope === "bot");

check("两种作用域的页面都在清单里", Boolean(appPage) && Boolean(botPage));
check("app 页面 id 由框架拼装(能进 hash 路由)", appPage?.key === "svc-probe-global", appPage?.key);
check(
	"模块 URL 指向插件 public 且带版本参数(ES 模块按 URL 缓存, 必须换地址)",
	appPage?.module === `/service/probe/public/page/global.js?v=${registered.version}`,
	appPage?.module,
);
check("图标 URL 同样拼好", appPage?.icon === `/service/probe/public/shield.svg?v=${registered.version}`, appPage?.icon);
check("样式表 URL 同样拼好", appPage?.styles?.[0] === `/service/probe/public/page/rows.css?v=${registered.version}`, appPage?.styles?.[0]);
check(
	"二级菜单骨架带拼好的模块 URL",
	appPage?.menu?.length === 1 && appPage.menu[0].module === appPage.module && appPage.menu[0].key === "global:全局名单",
	JSON.stringify(appPage?.menu),
);
check("bot 作用域不带二级菜单", botPage?.menu?.length === 0);
check("版本号随注册递增", registered.version > before.version, `${before.version} -> ${registered.version}`);

disposeApp();
const afterAppDispose = await (await get(`${base}/api/get_webui_pages`, cookie)).json();
check("注销后 app 页面从清单消失", !afterAppDispose.pages.some((p: any) => p.scope === "app"));
check("注销也让版本号递增", afterAppDispose.version > registered.version, `${registered.version} -> ${afterAppDispose.version}`);

// 重新注册同一 id: 服务停用后重新启用是正常路径, 且旧注销不该顶掉新条目
const pageFirst = webui.pages.register({ id: "again", title: "第一版", module: "page/a.js" });
const pageSecond = webui.pages.register({ id: "again", title: "第二版", module: "page/a.js" });
pageFirst();
const pageAgain = await (await get(`${base}/api/get_webui_pages`, cookie)).json();
check("同 id 重新注册只换条目", pageAgain.pages.filter((p: any) => p.key === "svc-probe-again").length === 1);
check("旧注销不影响重新注册的条目", pageAgain.pages.find((p: any) => p.key === "svc-probe-again")?.title === "第二版");
pageSecond();

// 排序: order 小的在前, 同 order 按注册顺序
webui.pages.register({ id: "late", title: "靠后", module: "page/l.js", order: 900 });
webui.pages.register({ id: "early", title: "靠前", module: "page/e.js", order: 10 });
const sorted = await (await get(`${base}/api/get_webui_pages`, cookie)).json();
const appKeys: string[] = sorted.pages.filter((p: any) => p.scope === "app").map((p: any) => p.key);
check("清单按 order 升序", JSON.stringify(appKeys) === JSON.stringify(["svc-probe-early", "svc-probe-late"]), JSON.stringify(appKeys));

/* ---------- 6. 非法注册被拒绝 ---------- */

console.log("-- 非法注册 --");

function rejects(run: () => unknown): boolean {
	try {
		run();
		return false;
	} catch (e) {
		return e instanceof StateError;
	}
}

function rejectsPage(run: () => unknown): boolean {
	return rejects(run);
}

check("页面 id 非单段被拒绝", rejectsPage(() => webui.pages.register({ id: "a b", title: "x", module: "p.js" })));
check("模块路径含 .. 被拒绝", rejectsPage(() => webui.pages.register({ id: "ok", title: "x", module: "../secret.js" })));
check("模块路径为绝对路径被拒绝", rejectsPage(() => webui.pages.register({ id: "ok", title: "x", module: "/etc/passwd" })));
check("模块路径带 ./ 前缀被拒绝", rejectsPage(() => webui.pages.register({ id: "ok", title: "x", module: "./p.js" })));
check("缺少 title 被拒绝", rejectsPage(() => webui.pages.register({ id: "ok", module: "p.js" } as any)));
check("缺少 module 被拒绝", rejectsPage(() => webui.pages.register({ id: "ok", title: "x" } as any)));
check("menu 项缺少 module 被拒绝", rejectsPage(() => webui.pages.register({ id: "ok", title: "x", module: "p.js", menu: [{ title: "m" } as any] })));
check("order 非数字被拒绝", rejectsPage(() => webui.pages.register({ id: "ok", title: "x", module: "p.js", order: "1" as any })));
check("归属 id 非单段被拒绝", rejectsPage(() => new WebUIAPI(server, "bad/id").pages.register({ id: "ok", title: "x", module: "p.js" })));

// 不同插件拼出同一个前端 id: 必须报错, 而不是静默顶掉前一个
webui.pages.register({ id: "global-x", title: "占位", module: "page/g.js" });
check(
	"不同插件撞同一个前端 id 被拒绝",
	rejectsPage(() => new WebUIAPI(server, "probe-global").pages.register({ id: "x", title: "撞车", module: "page/x.js" })),
);

/* ---------- 7. 端点注册的非法输入 ---------- */

check("路径含 / 被拒绝", rejects(() => webui.register({ path: "a/b", method: "POST", handler: () => 1 })));
check("不支持的请求方法被拒绝", rejects(() => webui.register({ path: "bad", method: "TRACE", handler: () => 1 })));
check("handler 非函数被拒绝", rejects(() => webui.register({ path: "bad", method: "POST", handler: null as any })));
check("归属 id 含路径字符被拒绝", rejects(() => new WebUIAPI(server, "bad/id").register({ path: "x", method: "POST", handler: () => 1 })));
check(
	"只有大小写不同的归属 id 被拒绝",
	rejects(() => new WebUIAPI(server, "PROBE").register({ path: "x", method: "POST", handler: () => 1 })),
);

/* ---------- 8. 释放 ---------- */

console.log("-- 释放 --");

await server.close();
check("关闭后不再监听", server.listening === null);
check("关闭后端点不再可达", await post(`${base}/service/probe/api/echo`, {}, cookie).then(() => false, () => true));

/* ---------- 7. 真实核心 API 目录 ---------- */

console.log("-- 真实核心 API 目录 --");

// 与 fixtures 分开: 直接用仓库里真正的 api 目录起一个服务器, 确认端点都在, 且
// 名单端点确实已经从核心搬走(它是这次抽离的对象, 最值得钉住)
const real = new WebUIServer({ port: 0, host: "127.0.0.1", staticDir, core });
await real.start();
core.webui = real;
const realBase = `http://127.0.0.1:${real.listening!.port}`;

const frontConfig = await get(`${realBase}/api/get_webui_front_config`);
check("核心 API 模块仍注册在 /api 下", frontConfig.status !== 404, `status=${frontConfig.status}`);

const moved = await post(`${realBase}/api/filter_list`, { action: "list", scope: "global" });
check("名单端点已不在核心 /api 下(由服务插件提供)", moved.status === 404, `status=${moved.status}`);

await real.close();

await fs.rm(apiDir, { recursive: true, force: true });
await fs.rm(staticDir, { recursive: true, force: true });
await fs.rm(pluginDir, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
// 本检查起过 HTTP 连接: 不用 process.exit 硬切(Windows 上会在 libuv 句柄收尾时触发断言),
// 只置退出码, 让事件循环自己排空
process.exitCode = failed === 0 ? 0 : 1;
