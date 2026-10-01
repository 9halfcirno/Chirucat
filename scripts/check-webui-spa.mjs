/**
 * SPA 引擎冒烟测试 (Node, 无浏览器)
 *
 * 目标: 在没有浏览器的环境里跑通一级导航 (页面注册/注销/排序) 与二级菜单
 * (运行期增删改查) 的行为 —— 这部分逻辑全在前端 JS 里, 不测就只能靠手点。
 *
 * 做法: 下面有一个极简 DOM 桩 (只实现 SPA 用到的那一小撮 API: 元素/类名/
 * 子节点/事件/matchMedia/hash 路由)。装到 globalThis 后再动态 import 前端
 * 模块 —— tooltip.js 在模块顶层就会注册 window 监听, 所以必须先有桩。
 *
 * 服务插件注册的页面用 data: URL 当模块、插件自带的真实前端模块则靠
 * plugin-frontend-import-map.mjs 解析绝对路径 import, 因此"清单 → import →
 * 渲染"整条链路都在这里真跑一遍。
 *
 * 运行: node scripts/check-webui-spa.mjs  (或 npm run check:webui-spa)
 */
import { register } from "node:module";

// ==================== 极简 DOM 桩 ====================

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this._classes = new Set();
		this._text = "";
		this._listeners = new Map();
		this._attrs = new Map();

		this.hidden = false;
		// 布局相关的量: 桩里全是固定值, 由用例按需改写
		this.offsetWidth = 0;
		this.offsetHeight = 0;
		this.clientWidth = 0;
		this.clientHeight = 0;
		this.scrollHeight = 0;

		this.style = { _props: new Map(), setProperty(k, v) { this._props.set(k, v); } };

		const self = this;
		this.classList = {
			add: (...names) => { for (const n of names) if (n) self._classes.add(n); },
			remove: (...names) => { for (const n of names) self._classes.delete(n); },
			contains: (n) => self._classes.has(n),
			toggle: (n, force) => {
				const on = force === undefined ? !self._classes.has(n) : Boolean(force);
				if (on) self._classes.add(n); else self._classes.delete(n);
				return on;
			},
		};
	}

	get className() { return [...this._classes].join(" "); }
	set className(value) {
		this._classes = new Set(String(value ?? "").split(/\s+/).filter(Boolean));
	}

	get textContent() {
		if (this.children.length === 0) return this._text;
		return this._text + this.children.map((c) => c.textContent).join("");
	}
	set textContent(value) {
		this._text = String(value ?? "");
		this._detachAll();
	}
	/* 桩里把 innerHTML 当纯文本处理 (够用: 只被 createButton 与示例内容用来写文字) */
	get innerHTML() { return this._text; }
	set innerHTML(value) { this.textContent = value; }

	appendChild(node) {
		node.parent = this;
		this.children.push(node);
		// 浏览器里外链资源是异步加载完再触发 load; 样式表加载靠它 resolve
		if (node.tagName === "LINK") setTimeout(() => node.fire("load"), 0);
		return node;
	}
	append(...nodes) {
		for (const node of nodes) this.appendChild(node);
	}
	prepend(...nodes) {
		for (const node of nodes) node.parent = this;
		this.children.unshift(...nodes);
	}
	replaceChildren(...nodes) {
		this._detachAll();
		this.append(...nodes);
	}
	remove() {
		if (!this.parent) return;
		const at = this.parent.children.indexOf(this);
		if (at >= 0) this.parent.children.splice(at, 1);
		this.parent = null;
	}
	_detachAll() {
		for (const child of this.children) child.parent = null;
		this.children = [];
	}

	setAttribute(name, value) { this._attrs.set(name, String(value)); }
	getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }

	addEventListener(type, fn) {
		if (!this._listeners.has(type)) this._listeners.set(type, []);
		this._listeners.get(type).push(fn);
	}
	removeEventListener(type, fn) {
		const list = this._listeners.get(type) ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
	}
	/** 桩专用: 触发事件 (浏览器行为里由用户操作/浏览器调度触发) */
	fire(type, event = {}) {
		const e = { type, currentTarget: this, target: this, preventDefault() { }, ...event };
		// 两种注册方式都要照顾: onclick=... 与 addEventListener("click", ...)
		if (typeof this[`on${type}`] === "function") this[`on${type}`](e);
		for (const fn of [...(this._listeners.get(type) ?? [])]) fn(e);
		return e;
	}

	/** 桩专用: 点击并等待异步处理器跑完 (createButton 的 onclick 是异步的) */
	async click() {
		const e = { type: "click", currentTarget: this, target: this, preventDefault() { } };
		if (typeof this.onclick === "function") await this.onclick(e);
		for (const fn of [...(this._listeners.get("click") ?? [])]) await fn(e);
		await new Promise((r) => setTimeout(r, 0));
	}

	getBoundingClientRect() {
		return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	}

	/** 只支持最简单的选择器: ".class" / "tag", 以及空格分隔的后代选择器 */
	querySelector(selector) { return this._find(selector)[0] ?? null; }
	querySelectorAll(selector) { return this._find(selector); }
	_find(selector) {
		const parts = String(selector).trim().split(/\s+/);
		const last = parts[parts.length - 1];
		const match = (el, sel) => sel.startsWith(".")
			? el._classes.has(sel.slice(1))
			: el.tagName === sel.toUpperCase();
		const hasAncestor = (el, sel) => {
			for (let p = el.parent; p; p = p.parent) if (match(p, sel)) return true;
			return false;
		};

		const found = [];
		const walk = (el) => {
			for (const child of el.children) {
				if (match(child, last) && parts.slice(0, -1).every((sel) => hasAncestor(child, sel))) {
					found.push(child);
				}
				walk(child);
			}
		};
		walk(this);
		return found;
	}
}

const elements = new Map();
const hashChangeListeners = [];
/** 浏览器里 hash 是地址栏的一部分; 赋值会异步派发 hashchange */
let hash = "";

const location = {
	pathname: "/",
	search: "",
	protocol: "http:",
	hostname: "localhost",
	port: "80",
	get hash() { return hash; },
	set hash(value) {
		const next = value === "" ? "" : (String(value).startsWith("#") ? String(value) : `#${value}`);
		if (next === hash) return;
		hash = next;
		setTimeout(() => { for (const fn of [...hashChangeListeners]) fn(); }, 0);
	},
};

const documentStub = {
	head: new El("head"),
	body: new El("body"),
	documentElement: { dataset: {} },
	createElement: (tag) => new El(tag),
	getElementById: (id) => elements.get(id) ?? null,
	addEventListener: () => { },
	removeEventListener: () => { },
	querySelector: () => null,
};

const windowStub = {
	innerWidth: 1400,
	innerHeight: 900,
	addEventListener(type, fn) {
		if (type === "hashchange") hashChangeListeners.push(fn);
	},
	removeEventListener() { },
};

const historyStub = {
	// replaceState 只改地址栏, 不派发 hashchange (与浏览器一致)
	replaceState(_state, _title, url) {
		if (typeof url === "string" && url.startsWith("#")) hash = url;
		else if (typeof url === "string") hash = "";
	},
};

globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.location = location;
globalThis.history = historyStub;

// matchMedia: 同一个查询返回同一个对象 (与浏览器一致), 用例可直接改它的 matches
const mediaQueries = new Map();
globalThis.matchMedia = (query) => {
	if (!mediaQueries.has(query)) {
		mediaQueries.set(query, { matches: false, addEventListener() { }, removeEventListener() { } });
	}
	return mediaQueries.get(query);
};
const NARROW = "(max-width: 768px)";
function setNarrow(matches) {
	globalThis.matchMedia(NARROW).matches = matches;
}

// 页面骨架: #main / #page-view / #activity-bar / #side-bar
const main = new El("div");
main.clientHeight = 800;
const root = new El("div");
const nav = new El("nav");
const sideBar = new El("aside");
elements.set("main", main);
elements.set("page-view", root);
elements.set("activity-bar", nav);
elements.set("side-bar", sideBar);

// ==================== 断言小工具 ====================

let failures = 0;
let checks = 0;

function ok(cond, name, detail = "") {
	checks++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
		return true;
	}
	failures++;
	console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
	return false;
}

function eq(actual, expected, name) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	return ok(a === b, name, `实际 ${a}, 期望 ${b}`);
}

/** 等若干拍宏任务: hashchange / 遮罩 / 渲染都是异步的 */
async function settle(rounds = 5) {
	for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function section(title) {
	console.log(`\n== ${title} ==`);
}

/** 活动栏按钮标题 (按显示顺序) */
function navTitles() {
	return nav.children.map((btn) => btn.getAttribute("aria-label"));
}
function navHas(title) {
	return navTitles().includes(title);
}
/** 二级菜单节点 (按显示顺序) */
function menuNodes() {
	return sideBar.querySelector(".spa-sidebar")?.children ?? [];
}
function menuTitles() {
	return menuNodes().map((n) => n.textContent);
}
function activeTitle() {
	const node = menuNodes().find((n) => n.classList.contains("active"));
	return node ? node.textContent : null;
}
/** 内容区 (二级菜单项内容的落点) 文本 */
function contentText() {
	return root.querySelector(".spa-sidebar-content")?.textContent ?? "";
}
/** 页面骨架文本 (页面自己渲染的, 不含二级菜单内容) */
function pageBone() {
	return root.querySelector(".bone")?.textContent ?? "";
}

function makePage(id, title, sidebar = [], log = []) {
	return {
		id,
		title,
		sidebar,
		render(container, app) {
			log.push(`render:${id}`);
			this.lastApp = app;
			// 骨架放在自己的子节点里: 页面容器末尾还会挂二级菜单的内容宿主
			const bone = document.createElement("div");
			bone.className = "bone";
			bone.textContent = `${title}-骨架`;
			container.appendChild(bone);
		},
		destroy() { log.push(`destroy:${id}`); },
	};
}

/** 造一个二级菜单项定义, 渲染时把自己的标题写进内容区 */
function menuItem(title, log = []) {
	return {
		title,
		render(container) {
			log.push(`item:${title}`);
			container.textContent = `内容:${title}`;
		},
	};
}

// ==================== 用例 ====================

const { createApp, getApp } = await import("../src/webui/public/js/spa/framework.js");
const { startServicePages } = await import("../src/webui/public/js/spa/service-pages.js");

// 插件前端模块按浏览器语义写绝对路径 import ("/js/spa/api.js"), Node 默认解析不了 ——
// 挂一个解析钩子, 于是"插件 public 下的真实模块"也能在无浏览器环境里 import 并渲染
register("./plugin-frontend-import-map.mjs", import.meta.url);

const log = [];
const app = createApp({ minLoadTime: 0, fadeMs: 0 });

section("未打开任何页面时的动态菜单操作");
ok(getApp() === app, "getApp() 返回刚创建的应用");
let threw = false;
try { app.sidebar.add({ title: "无主项" }); } catch { threw = true; }
ok(threw, "没有当前页面且未指定 page 时, add 明确报错");

section("启动前注册 + start(): 一级导航与声明式二级菜单");
app.register(makePage("home", "首页", [menuItem("概览", log), menuItem("明细", log)], log));
app.register(makePage("logs", "日志", ["分组", menuItem("全部", log)], log));
app.start();
await settle();

eq(navTitles(), ["首页", "日志"], "活动栏按注册顺序生成按钮");
eq(pageBone(), "首页-骨架", "启动后打开了第一个页面");
eq(app.sidebar.currentPageId(), "home", "当前页面 id 正确");
eq(menuTitles(), ["概览", "明细"], "声明式二级菜单已渲染");
eq(activeTitle(), "概览", "首个可点击项自动选中");
eq(contentText(), "内容:概览", "选中项的内容渲染进页面容器");
eq(sideBar.querySelectorAll(".spa-sidebar-label").length, 0, "home 页没有文本项");

section("运行期新增二级菜单 (当前页面)");
const dynamic = app.sidebar.add(menuItem("实时", log), { index: 1 });
eq(menuTitles(), ["概览", "实时", "明细"], "动态项插到指定位置");
eq(activeTitle(), "概览", "新增菜单不打断当前选中项");
ok(dynamic && typeof dynamic.id === "string", "add 返回带 id 的规范化项");

await app.sidebar.select("实时");
eq(contentText(), "内容:实时", "select 切换内容");
eq(activeTitle(), "实时", "select 更新选中态");
ok(log.includes("item:实时"), "切换确实重新渲染了内容");

section("运行期删除二级菜单");
eq(app.sidebar.remove("实时"), true, "remove 按 id 删除返回 true");
eq(menuTitles(), ["概览", "明细"], "删除后按钮列表立即更新");
eq(activeTitle(), "概览", "被删的正是选中项时, 就近改选第一个");
eq(contentText(), "内容:概览", "内容跟着换到新选中项");

eq(app.sidebar.remove("明细"), true, "remove 声明式项");
eq(menuTitles(), ["概览"], "声明式项也能删");
await app.navigate("logs", { push: false });
await app.navigate("home", { push: false });
eq(menuTitles(), ["概览"], "离开再回来, 被删的声明式项不会自己冒回来");
eq(app.sidebar.list().map((i) => i.title), ["概览"], "list() 与界面一致");

section("同 id 视为同一条菜单 (更新而不是重复)");
const before = menuTitles();
app.sidebar.add({ id: "概览", title: "总览", render: (el) => { el.textContent = "内容:总览"; } });
eq(menuTitles(), ["总览"], "同 id 的项就地更新 (数量不变)");
ok(before.length === 1, "更新前也只有一项");

section("文本项 (分组标题)");
app.sidebar.add("分组标题");
eq(menuTitles(), ["总览", "分组标题"], "字符串项作为文本项追加");
eq(sideBar.querySelectorAll(".spa-sidebar-label").length, 1, "文本项用的是 .spa-sidebar-label");
await app.sidebar.select("分组标题");
eq(activeTitle(), "总览", "文本项不可选中 (选中态不动)");

section("set() 整表替换 / reset() 回到声明式");
app.sidebar.set([menuItem("A", log), menuItem("B", log)]);
eq(menuTitles(), ["A", "B"], "set 替换掉整份菜单");
eq(contentText(), "内容:A", "set 之后自动选中第一项");
app.sidebar.reset();
eq(menuTitles(), ["概览", "明细"], "reset 丢掉全部动态状态, 回到页面声明的菜单 (抑制标记也一并清掉)");

section("给未打开的页面预埋菜单");
app.sidebar.add(menuItem("预埋", log), { page: "logs" });
eq(menuTitles(), ["概览", "明细"], "不是当前页面: 只记账, 不动当前界面");
await app.navigate("logs", { push: false });
eq(menuTitles(), ["分组", "全部", "预埋"], "打开该页面时预埋项一并渲染");
eq(app.sidebar.list({ page: "logs" }).map((i) => i.title), ["分组", "全部", "预埋"], "list({page}) 可跨页面查询");

section("start() 之后注册一级页面");
app.register(makePage("users", "用户", [menuItem("列表", log)], log));
await settle();
eq(navTitles(), ["首页", "日志", "用户"], "活动栏立即多出按钮");
eq(log.filter((l) => l === "render:users").length, 0, "新注册的页面不会自动抢当前页");
await app.navigate("users", { push: false });
eq(pageBone(), "用户-骨架", "新页面可正常打开");
eq(menuTitles(), ["列表"], "新页面的二级菜单正常");

section("update(): 改标题 / 调顺序");
app.update("users", { title: "用户管理" });
eq(navTitles(), ["首页", "日志", "用户管理"], "标题更新反映到活动栏");
app.update("users", { index: 0 });
eq(navTitles(), ["用户管理", "首页", "日志"], "index 调整一级导航顺序");
eq(app.listPages().map((p) => p.id), ["users", "home", "logs"], "listPages() 顺序一致");
threw = false;
try { app.update("users", { id: "other" }); } catch { threw = true; }
ok(threw, "禁止通过 update 改页面 id");

section("页面模块没有 id 时, 菜单按注册 id 记账 (settings 页正是如此)");
// 设置页这类模块只声明 title/render/sidebar, 没有 id —— 记账必须用框架的注册 id
app.register({
	id: "modless",
	title: "无模块id",
	load: async () => ({
		default: {
			title: "无模块id",
			sidebar: [menuItem("甲", log)],
			render(container) {
				const bone = document.createElement("div");
				bone.className = "bone";
				bone.textContent = "无id-骨架";
				container.appendChild(bone);
			},
		},
	}),
});
await app.navigate("modless", { push: false });
eq(pageBone(), "无id-骨架", "页面正常打开");
eq(app.sidebar.currentPageId(), "modless", "当前页面记账用的是注册 id");
eq(menuTitles(), ["甲"], "声明式菜单正常渲染");
app.sidebar.add(menuItem("乙", log));
eq(menuTitles(), ["甲", "乙"], "动态菜单也能挂到这个页面上");
eq(app.sidebar.list({ page: "modless" }).map((i) => i.title), ["甲", "乙"], "list({page}) 认得这个页面");

section("深链先到 / 页面后注册");
location.hash = "#/late";
await settle();
eq(location.hash, "#/late", "未注册的深链不改写地址栏 (留给稍后注册的页面)");
eq(pageBone(), "用户-骨架", "先落到第一个页面 (此时 users 排在最前)");
app.register(makePage("late", "迟到", [menuItem("子项", log)], log));
await settle();
eq(pageBone(), "迟到-骨架", "页面注册上来后按 hash 自动打开");
eq(navHas("迟到"), true, "活动栏也有它");

section("注销一级页面");
eq(app.unregister("users"), true, "unregister 返回 true");
eq(navHas("用户管理"), false, "非当前页面: 活动栏去掉按钮");
eq(app.unregister("users"), false, "重复注销返回 false");

eq(app.unregister("late"), true, "注销当前页面");
await settle();
// users 已在上面被注销, 剩下的第一个页面是 home
eq(pageBone(), "首页-骨架", "落到的确实是第一个页面 (home)");
eq(location.hash, "#/home", "地址栏改写为兜底页面 (不新增历史记录)");
eq(log.filter((l) => l === "destroy:late").length, 1, "被注销的页面收到了 destroy()");
eq(app.sidebar.list({ page: "late" }).length, 0, "被注销页面的动态菜单状态一并丢弃");

section("没有菜单项的页面 (nav-collapsed) 与运行期补菜单");
app.register(makePage("empty", "空页", [], log));
await app.navigate("empty", { push: false });
ok(documentStub.body.classList.contains("nav-collapsed"), "没有菜单项时侧栏整块隐藏");
const injected = app.sidebar.add(menuItem("事后", log));
ok(!documentStub.body.classList.contains("nav-collapsed"), "运行期补上菜单后侧栏重新出现");
eq(menuTitles(), ["事后"], "补上的项立即渲染");
eq(contentText(), "内容:事后", "并且自动选中渲染内容");
app.sidebar.remove(injected);
ok(documentStub.body.classList.contains("nav-collapsed"), "删光后又隐藏");
ok(!!sideBar.querySelector(".spa-sidebar"), "内容宿主仍在 (下次动态新增才有落点)");

section("TestLab 页面: 演示代码本身可用 (真页面 + 真按钮)");
const testPage = (await import("../src/webui/public/js/pages/test/index.js")).default;
app.register({ id: "test", title: "测试页面", load: async () => ({ default: testPage }) });
await app.navigate("test", { push: false });
eq(app.sidebar.currentPageId(), "test", "打开了测试页");
eq(app.sidebar.list({ page: "test" }).map((i) => i.title), ["项一", "项二", "测试", "项三"], "声明式菜单就位");

/** 按按钮文字找到页面里的那个按钮 (找不到就报错) */
function labButton(text) {
	const btn = root.querySelectorAll(".btn").find((b) => b.textContent === text);
	ok(!!btn, `找得到按钮「${text}」`);
	return btn;
}

await labButton("追加一项 (add)").click();
eq(app.sidebar.list({ page: "test" }).length, 5, "[追加一项]: 菜单多一项");
eq(activeTitle(), "动态项 1", "[追加一项]: 新项被自动选中");

await labButton("插到第 2 位 (index)").click();
eq(app.sidebar.list({ page: "test" })[1].title, "插队项 2", "[插到第 2 位]: 插到指定位置");

await labButton("加文本分组 (字符串项)").click();
const withLabel = app.sidebar.list({ page: "test" });
eq(withLabel[withLabel.length - 1].kind, "label", "[加文本分组]: 末尾是不可点的文本项");

await labButton("同 id 更新首项").click();
eq(app.sidebar.list({ page: "test" })[0].title, "项一*", "[同 id 更新首项]: 首项就地改名");

await labButton("set 整表替换").click();
eq(app.sidebar.list({ page: "test" }).map((i) => i.title), ["set 项 3", "set 里的文本项", "set 项 4"], "[set 整表替换]: 只剩 set 的三项");

await labButton("reset (回到声明式)").click();
eq(app.sidebar.list({ page: "test" }).map((i) => i.title), ["项一", "项二", "测试", "项三"], "[reset]: 动态项消失, 声明项回来 (改名也是动态的, 一并消失)");

await labButton("注册实验页").click();
ok(app.hasPage("lab-1"), "[注册实验页]: 页面注册成功");
ok(navHas("实验页 1"), "[注册实验页]: 活动栏多出按钮");
await labButton("改标题 (update)").click();
eq(app.getPage("lab-1").title, "实验页 1*", "[改标题]: update 生效");
await labButton("挪到第一位").click();
eq(app.listPages()[0].id, "lab-1", "[挪到第一位]: 顺序被调整");

// 进实验页: 内联页面自己挂菜单、自己注销自己
await app.navigate("lab-1", { push: false });
eq(app.sidebar.list({ page: "lab-1" }).map((i) => i.title), ["实验页自带的项"], "内联页面打开时渲染了自己的声明式菜单");
await labButton("给自己加一项二级菜单").click();
eq(app.sidebar.list({ page: "lab-1" }).map((i) => i.title), ["实验页自带的项", "实验页项 1"], "内联页面给自己 add 了菜单项");
eq(activeTitle(), "实验页项 1", "新项被自动选中");
await labButton("从本页注销自己").click();
await settle();
ok(!app.hasPage("lab-1"), "[从本页注销自己]: 页面已注销");
ok(!navHas("实验页 1*"), "活动栏按钮消失, 落到剩下的第一个页面");
eq(app.sidebar.list({ page: "lab-1" }).length, 0, "被注销页面的菜单表也清掉了");

await app.navigate("test", { push: false }); // 回到 TestLab 继续后面的用例
await labButton("给日志页预埋一项").click();
ok(app.sidebar.list({ page: "logs" }).some((i) => i.title.includes("预埋项")), "[给日志页预埋一项]: logs 页的菜单表多了它");
await labButton("查看日志页菜单 (list)").click();
await labButton("删掉日志页预埋项").click();
ok(!app.sidebar.list({ page: "logs" }).some((i) => i.title.includes("预埋项")), "[删掉日志页预埋项]: 又没了");

ok(root.querySelectorAll(".test-log-line").length > 0, "页面把调用记进了日志区");
eq(root.querySelectorAll(".test-snapshot li").length, app.sidebar.list({ page: "test" }).length, "页面的菜单快照与菜单表一致");
await labButton("清空日志").click();
eq(root.querySelectorAll(".test-log-line").length, 0, "[清空日志]: 日志区被清空");

section("服务插件页面: 清单对账 (新增 / 更新 / 停用注销 / 顺序)");

// 插件页面的模块用 data: URL 提供: Node 的 ESM 加载器支持 data: 导入, 于是
// "清单 → import 模块 → 渲染"整条链路都能在没有浏览器的环境里跑通
const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const filterPageModule = dataModule(`
export default {
	render(container) { container.textContent = "黑白名单插件页"; },
};
`);
const filterMenuModule = dataModule(`
export default (container) => { container.textContent = "全局名单菜单内容"; };
`);
const earlyPageModule = dataModule(`
export default { render(container) { container.textContent = "靠前的插件页"; } };
`);
const botModule = dataModule(`
export default { render(container, bot) { container.textContent = "Bot 名单: " + bot.id; } };
`);

/** 服务端清单的替身 */
function pageViews(version, pages) {
	return { version, pages };
}

let payload = pageViews(1, []);
let fetchCount = 0;
globalThis.fetch = async (url) => {
	fetchCount++;
	if (String(url).includes("/api/get_webui_pages")) {
		return { ok: true, status: 200, json: async () => payload };
	}
	return { ok: false, status: 404, json: async () => ({ err: `unexpected url ${url}` }) };
};

// 锚点页面: 服务插件页面统一插在它之前 (app.js 里锚点是"插件"页)
app.register({ id: "plugins", title: "插件", icon: "/img/icons/plugin.svg", render(el) { el.textContent = "插件页"; } });

const serviceSync = startServicePages(app, { insertBefore: "plugins", pollMs: 0 });
await serviceSync.sync();
eq(fetchCount, 1, "启动时对账拉了一次清单(空清单)");
eq(serviceSync.appliedIds(), [], "空清单不注册任何页面");

const filterView = {
	key: "svc-chirucat-filter-global",
	scope: "app",
	service: "chirucat-filter",
	title: "黑白名单",
	icon: "/service/chirucat-filter/public/shield.svg?v=2",
	module: filterPageModule,
	styles: ["/service/chirucat-filter/public/filters.css?v=2"],
	order: 50,
	menu: [{ key: "global:全局名单", title: "全局名单", module: filterMenuModule, styles: [] }],
};
const earlyView = {
	key: "svc-demo-early",
	scope: "app",
	service: "demo",
	title: "靠前的插件页",
	icon: null,
	module: earlyPageModule,
	styles: [],
	order: 10,
	menu: [],
};
const botView = {
	key: "chirucat-filter-filter",
	scope: "bot",
	service: "chirucat-filter",
	title: "名单",
	icon: null,
	module: botModule,
	styles: [],
	order: 30,
	menu: [],
};

payload = pageViews(2, [earlyView, filterView, botView]);
await serviceSync.sync();

ok(app.hasPage("svc-chirucat-filter-global"), "插件页面被注册进一级导航");
ok(app.hasPage("svc-demo-early"), "第二个插件页面也注册了");
// 服务插件页面保持连续, 统一插在锚点页面("插件")之前, 内部按 order 升序
eq(navTitles().slice(-3), ["靠前的插件页", "黑白名单", "插件"], "服务插件页面按 order 插在锚点页面之前");
eq(navTitles().filter((t) => t === "插件").length, 1, "锚点页面本身没被顶掉");
eq(serviceSync.botPages().map((v) => v.title), ["名单"], "bot 作用域条目单独暴露给 Bot 窗口");
eq(serviceSync.appliedIds().sort(), ["svc-chirucat-filter-global", "svc-demo-early"], "appliedIds 与清单一致");
eq(app.getPage("svc-chirucat-filter-global").icon, "/service/chirucat-filter/public/shield.svg?v=2", "图标用服务端拼好的 URL");

// 打开插件页面: 模块被 import, 二级菜单渲染, 样式表被加载
await app.navigate("svc-chirucat-filter-global", { push: false });
eq(app.sidebar.list({ page: "svc-chirucat-filter-global" }).map((i) => i.title), ["全局名单"], "页面声明的二级菜单就位");
eq(contentText(), "全局名单菜单内容", "二级菜单项渲染了插件模块");
ok(documentStub.head.children.some((l) => String(l.href).includes("/service/chirucat-filter/public/filters.css")), "页面样式表已加载");

// 标题变化(同 id 的新定义) → update, 不重建页面对象
payload = pageViews(3, [{ ...earlyView }, { ...filterView, title: "过滤名单" }, botView]);
await serviceSync.sync();
ok(navHas("过滤名单") && !navHas("黑白名单"), "标题变化走 update");

// 停用当前页面: 注销 + 落到别的页面 + 提示
payload = pageViews(4, [earlyView, botView]);
await serviceSync.sync();
await settle(6); // 注销当前页会异步落到兜底页面
ok(!app.hasPage("svc-chirucat-filter-global"), "服务停用后页面被注销");
eq(app.sidebar.currentPageId(), "home", "当时正打开它: 已落到剩下的第一个页面");
const toasts = documentStub.body.querySelectorAll(".toast-msg");
ok(String(toasts[toasts.length - 1]?.textContent).includes("所属的服务已停用"), "并且提示了原因");

// 版本号没变: 不重复注册、不改动导航
payload = pageViews(5, [earlyView, filterView]);
await serviceSync.sync();
const orderAfter = app.listPages().map((p) => p.id).join(",");
const fetchBefore = fetchCount;
await serviceSync.sync();
eq(fetchCount, fetchBefore + 1, "版本没变也会拉一次清单(便宜)");
eq(app.listPages().map((p) => p.id).join(","), orderAfter, "版本没变时导航一动不动");
eq(serviceSync.appliedIds().length, 2, "也不重复注册");

// 回归: 强制对账(服务页/服务管理页每次操作都会强制拉一次)必须幂等
// 曾经的 bug: 目标下标按"锚点当前下标"算, 而它已经含了插进去的服务页面,
// 于是每次强制对账都把整块往后挪一格、下一次又挪回来 —— 按钮在锚点前后跳
await serviceSync.sync(true);
eq(app.listPages().map((p) => p.id).join(","), orderAfter, "强制对账一次后位置不动(不漂移)");
await serviceSync.sync(true);
eq(app.listPages().map((p) => p.id).join(","), orderAfter, "连续强制对账也稳定");
ok(
	app.listPages().findIndex((p) => p.id === "svc-chirucat-filter-global")
	< app.listPages().findIndex((p) => p.id === "plugins"),
	"服务插件页面始终在锚点页面之前",
);

// 新来的页面即使注册得更晚, 也要按 order 排到正确位置
const lateView = {
	key: "svc-demo-late",
	scope: "app",
	service: "demo",
	title: "最后来的插件页",
	icon: null,
	module: earlyPageModule,
	styles: [],
	order: 60,
	menu: [],
};
payload = pageViews(6, [earlyView, filterView, lateView]);
await serviceSync.sync();
eq(
	app.listPages().map((p) => p.id).slice(-4),
	["svc-demo-early", "svc-chirucat-filter-global", "svc-demo-late", "plugins"],
	"后注册的页面按 order 插进服务页段(而不是甩到末尾)",
);

section("filter 插件的真实前端模块 (迁移到 services/filter/public 之后仍可用)");

const filterGlobal = (await import("../services/filter/public/global.js")).default;
eq(typeof filterGlobal.render, "function", "public/global.js 导出可渲染的页面对象");

const filterHost = document.createElement("div");
filterGlobal.render(filterHost);
await settle(6);
ok(filterHost.textContent.includes("对所有 Bot 生效的全局名单"), "渲染出全局名单页的提示文案");
eq(filterHost.querySelectorAll(".filters-table").length, 2, "用户名单 / 会话名单两张表都建了出来");
eq(filterHost.querySelectorAll(".filters-error").length, 2, "接口不可用时把原因显示在表里(而不是崩掉)");

const filterBot = (await import("../services/filter/public/bot.js")).default;
const filterBotHost = document.createElement("div");
filterBot.render(filterBotHost, { id: "bot-a", name: "机器人A" });
await settle(6);
ok(filterBotHost.textContent.includes("只对当前 Bot 生效"), "public/bot.js 渲染 Bot 私有名单视图");
eq(filterBotHost.querySelectorAll(".filters-table").length, 2, "Bot 视图同样建出两张表");

section("Bot 详情窗口: 服务插件页面的挂载与实时消失");

const { createBotContent } = await import("../src/webui/public/js/pages/bots/bot-content.js");

payload = pageViews(7, [filterView, botView]);
await serviceSync.sync();
eq(serviceSync.botPages().map((v) => v.title), ["名单"], "清单里有 bot 作用域页面");

const botContent = createBotContent({ id: "bot-a", name: "机器人A" });
documentStub.body.appendChild(botContent);
await settle(12);

const botNav = () => botContent.querySelector(".bot-nav");
const botMain = () => botContent.querySelector(".bot-main");
eq(botNav().children.map((b) => b.getAttribute("aria-label")), ["信息", "插件", "名单", "设置"], "核心子页 + 插件页按 order 合并排序");
eq(botMain().textContent.includes("id: bot-a"), true, "默认打开第一项(信息)");

await botNav().children[2].click();
await settle(4);
eq(botMain().textContent, "Bot 名单: bot-a", "插件页面拿到当前 Bot 并渲染");

// 服务停用: 已经打开的窗口里那一项当场消失, 并落到第一项
payload = pageViews(8, [filterView]);
await serviceSync.sync();
await settle(4);
eq(botNav().children.map((b) => b.getAttribute("aria-label")), ["信息", "插件", "设置"], "停用后该项从窗口里消失");
eq(botMain().textContent.includes("id: bot-a"), true, "停在它上面时落到第一项");

// 窗口关闭后不再响应清单变化
botContent.disposeBotContent();
payload = pageViews(9, [filterView, botView]);
await serviceSync.sync();
await settle(3);
eq(botNav().children.length, 3, "关闭后的窗口不再被清单变化驱动");

section("窄屏折叠菜单在列表变化时不崩");
setNarrow(true);
await app.navigate("home", { push: false });
const toggle = sideBar.querySelector(".sidebar-toggle");
ok(!!toggle, "折叠 header 条已渲染");
sideBar.querySelector(".spa-sidebar").scrollHeight = 300; // 内容自然高度
toggle.fire("click");
eq(toggle.getAttribute("aria-expanded"), "true", "窄屏点击展开");
ok(sideBar.querySelector(".spa-sidebar").style.height !== "0px", "展开时写出了具体高度");
app.sidebar.add(menuItem("丙", log));
eq(menuTitles(), ["概览", "明细", "丙"], "展开状态下增删菜单正常");
ok(sideBar.querySelector(".spa-sidebar").style.height === "300px", "列表变化后按新内容重算高度");
toggle.fire("click");
eq(toggle.getAttribute("aria-expanded"), "false", "再点收起");
eq(sideBar.querySelector(".spa-sidebar").style.height, "0px", "收起高度归零");
setNarrow(false);

// ==================== 汇总 ====================

console.log(`\n${failures === 0 ? "全部通过" : "有失败"}: ${checks - failures}/${checks}`);
if (failures > 0) process.exitCode = 1;
