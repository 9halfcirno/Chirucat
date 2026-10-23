/**
 * WebUI 前端入口
 *
 * 注册各个页面并启动 SPA 框架。
 * 新增页面时, 在下面的 registerPages() 里调用 app.register() 即可,
 * 活动栏按钮会自动生成。
 *
 * 这里只是**启动时**的那一批页面; 运行期的增删 (一级导航与二级菜单) 由框架
 * 提供的 API 负责, 例如插件前端资源可以:
 *
 * ```js
 * import { getApp } from "/js/spa/framework.js";
 * const app = getApp();
 * app.register({ id: "filter", title: "过滤", render(el) { ... } }); // 一级导航
 * app.sidebar.add({ title: "规则", render(el) { ... } });            // 当前页的二级菜单
 * ```
 *
 * 详见 js/spa/framework.js 与 js/spa/sidebar.js 的模块注释。
 *
 * 鉴权流程:
 * - 进入页面先请求 /api/auth/verify 查询登录状态
 * - 已登录 (或无密码): 注册固定页面 -> 显示主界面并启动 SPA
 * - 未登录: 隐藏主界面, 正中显示登录卡片; 登录成功后再走上面那条路径
 * - 任意 API 返回 401 (token 过期/换密码被吊销): 全局切回登录态
 *
 * 固定页面的注册放在鉴权通过之后, 避免主界面在鉴权结果出来之前闪一下。
 */
import { createApp } from "./js/spa/framework.js";
import { startServicePages } from "./js/spa/service-pages.js";
import * as auth from "./js/spa/auth.js";
import toast from "./js/spa/toast.js";

const app = createApp({
	main: document.getElementById("main"),
	root: document.getElementById("page-view"),
	nav: document.getElementById("activity-bar"),
	title: document.getElementById("page-title"),
	sidebar: document.getElementById("side-bar"),
});

/**
 * 注册启动时的固定页面
 *
 * 统计页与测试页不在这里: 它们由后端页面清单 (`corePages`) 按模块/开关状态下发,
 * 由 startServicePages() 动态增删, 见 js/spa/service-pages.js。
 */
function registerPages() {
	app.register({
		id: "home",
		title: "首页",
		icon: "/img/icons/home.svg",
		load: () => import("./js/pages/home/home.js"),
	});

	app.register({
		id: "bots",
		title: "机器人",
		icon: "/img/icons/bot.svg",
		load: () => import("./js/pages/bots/bots.js"),
	});

	app.register({
		id: "users",
		title: "用户管理",
		icon: "/img/icons/user.svg",
		load: () => import("./js/pages/users/users.js"),
	});

	// 黑白名单页不在这里注册: 它是 `services/filter` 服务插件自带的前端页面,
	// 由 startServicePages() 按清单挂上来 —— 服务停用它就消失(见 js/spa/service-pages.js)

	app.register({
		id: "plugins",
		title: "插件",
		icon: "/img/icons/plugin.svg",
		load: () => import("./js/pages/plugins/plugins.js"),
	});

	app.register({
		id: "logs",
		title: "日志",
		icon: "/img/icons/log.svg",
		load: () => import("./js/pages/logs/logs.js"),
	});

	app.register({
		id: "settings",
		title: "设置",
		icon: "/img/icons/setting.svg",
		load: () => import("./js/pages/settings/settings.js"),
	});

	app.register({
		id: "info",
		title: "关于",
		icon: "/img/icons/info.svg",
		load: () => import("./js/pages/info/info.js"),
	});
}

// ---- 鉴权流程 ----

const loginView = document.getElementById("login-view");
const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginSubmit = document.getElementById("login-submit");
const loginError = document.getElementById("login-error");

/** 进入主界面: 隐藏登录卡片, 主界面淡入 (由 layout.css 的 transition 驱动) */
function showMain() {
	loginView.hidden = true;
	document.body.classList.remove("auth-pending");
	document.body.classList.add("authed");
}

/** 回到登录态: 隐藏主界面, 正中显示登录卡片 */
function showLogin() {
	document.body.classList.remove("authed");
	loginView.hidden = false;
}

/** 设置/清除登录卡片上的错误提示 */
function setLoginError(message) {
	if (!message) {
		loginError.textContent = "";
		loginError.hidden = true;
		return;
	}
	loginError.textContent = message;
	loginError.hidden = false;
}

/** 是否已完成"注册页面 + 启动 SPA" */
let bootstrapped = false;

/**
 * 进入主界面
 *
 * 首次调用: 注册固定页面 -> 显示主界面 -> 启动 SPA。
 * 之后调用 (登出后重新登录) 只切回主界面: 重复 app.register() 会抛
 * "页面重复注册", 重复 app.start() 会重跑导航, 都不该发生。
 */
function enterMain() {
	if (bootstrapped) {
		showMain();
		return;
	}
	bootstrapped = true;

	registerPages();
	showMain();
	app.start();

	// 服务插件注册的页面 (一级导航 + Bot 详情窗口的二级导航) 走清单对账:
	// 启动时拉一次, 之后服务启停/刷新时主动拉, 另有焦点触发与兜底轮询。
	// insertBefore 决定它们在活动栏里插在哪一段 —— 排在"插件"页之前。
	startServicePages(app, { insertBefore: "plugins" });
}

loginForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const password = loginPassword.value;
	if (!password || loginSubmit.disabled) return;

	loginSubmit.disabled = true;
	setLoginError("");
	try {
		await auth.login(password);
		loginPassword.value = "";
		enterMain();
	} catch (err) {
		setLoginError(err.message);
		loginPassword.select();
	} finally {
		loginSubmit.disabled = false;
	}
});

// token 过期/被吊销后, 任意 API 返回 401 -> 全局切回登录态
auth.onUnauthorized(() => {
	if (!document.body.classList.contains("authed")) return;
	showLogin();
	toast("登录已过期, 请重新登录", { type: "error" });
});

// 启动: 先查鉴权状态, 再决定进入主界面还是显示登录卡片
(async () => {
	if (await auth.verifyAuth()) {
		enterMain();
	} else {
		showLogin();
	}
})();

// ---- 主题切换 (跟随系统 / 浅色 / 深色 三态循环) ----
//
// 两个标记分工不同, 不要混:
//   data-theme-mode  用户选的模式 (auto|light|dark) → 决定顶栏显示哪个图标
//   data-theme       "dark" 或不存在 → 决定实际配色
// 跟随系统时 data-theme 会随系统偏好变化, 但 mode 始终是 auto。
// index.html 的 <head> 内联脚本早在首屏前就把这两者写好, 避免白闪;
// 这里只负责交互与持久化。
const THEME_KEY = "chirucat-theme";
const THEME_MODES = ["auto", "light", "dark"];
const THEME_MODE_NAMES = { auto: "跟随系统", light: "浅色", dark: "深色" };
const themeToggle = document.getElementById("theme-toggle");
const darkMedia = matchMedia("(prefers-color-scheme: dark)");

if (themeToggle) {
	/** 当前模式; 以 <head> 脚本写下的 data-theme-mode 为准 */
	let mode = THEME_MODES.includes(document.documentElement.dataset.themeMode)
		? document.documentElement.dataset.themeMode
		: "auto";

	/** 提示当前模式与下一次会切到什么 */
	function syncThemeLabel() {
		const next = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
		const label = `主题: ${THEME_MODE_NAMES[mode]} (点击切换到${THEME_MODE_NAMES[next]})`;
		themeToggle.title = label;
		themeToggle.setAttribute("aria-label", label);
	}

	/** 把模式落到 <html>: 写模式标记, 再按模式决定实际配色 */
	const applyMode = next => {
		mode = next;
		document.documentElement.dataset.themeMode = next;

		const dark = next === "dark" || (next === "auto" && darkMedia.matches);
		if (dark) document.documentElement.dataset.theme = "dark";
		else delete document.documentElement.dataset.theme;

		syncThemeLabel();
	};

	themeToggle.addEventListener("click", () => {
		const next = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
		applyMode(next);

		try {
			// 跟随系统也显式存下来, 这样用户能主动从手动模式切回跟随系统
			localStorage.setItem(THEME_KEY, next);
		} catch {
			/* localStorage 不可用 (隐私模式等): 本次会话内仍生效, 只是记不住 */
		}
	});

	// 跟随系统时, 系统偏好变了要立刻反映到配色上
	darkMedia.addEventListener("change", () => {
		if (mode === "auto") applyMode("auto");
	});

	syncThemeLabel();
}

// 窄屏的二级菜单 (折叠 header 条 / 展开高度) 由 js/spa/sidebar.js 负责,
// 不再需要独立的汉堡按钮与遮罩点击收起逻辑。

window.onerror = (e, source) => {
	toast(`Error: ${e} file: ${source}`, {
		type: "error"
	})
}

window.onunhandledrejection = (e) => {
	toast(`Error: ${e.reason}`, {
		type: "error"
	})
}
