/**
 * WebUI 前端入口
 *
 * 注册各个页面并启动 SPA 框架。
 * 新增页面时, 在这里调用 app.register() 即可, 侧边栏按钮会自动生成。
 *
 * 鉴权流程:
 * - 进入页面先请求 /api/auth/verify 查询登录状态
 * - 已登录 (或无密码): 直接显示主界面 (main-nav + main) 并启动 SPA
 * - 未登录: 隐藏主界面, 正中显示登录卡片; 登录成功后主界面从上方滑入
 * - 任意 API 返回 401 (token 过期/换密码被吊销): 全局切回登录态
 */
import { createApp } from "./js/spa/framework.js";
import * as auth from "./js/spa/auth.js";
import toast from "./js/spa/toast.js";

const app = createApp({
	main: document.getElementById("main"),
	root: document.getElementById("page-view"),
	nav: document.getElementById("main-nav"),
});

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

// ---- 鉴权流程 ----

const loginView = document.getElementById("login-view");
const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginSubmit = document.getElementById("login-submit");
const loginError = document.getElementById("login-error");

/** 进入主界面: 隐藏登录卡片, 主界面从上方滑入 (由 CSS transition 驱动) */
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

loginForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const password = loginPassword.value;
	if (!password || loginSubmit.disabled) return;

	loginSubmit.disabled = true;
	setLoginError("");
	try {
		await auth.login(password);
		loginPassword.value = "";
		showMain();
		app.start();
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

// 启动: 先查鉴权状态, 再决定显示主界面还是登录卡片
(async () => {
	if (await auth.verifyAuth()) {
		showMain();
		app.start();
	} else {
		showLogin();
	}
})();

// ---- 窄屏侧边栏抽屉: 顶部按钮展开/收起, 点外部或导航后自动收起 ----
const navToggle = document.getElementById("nav-toggle");
const mainNav = document.getElementById("main-nav");
if (navToggle && mainNav) {
	const setNavOpen = (open) => {
		document.body.classList.toggle("nav-open", open);
		navToggle.setAttribute("aria-expanded", String(open));
		navToggle.setAttribute("aria-label", open ? "收起导航" : "展开导航");
	};

	navToggle.addEventListener("click", () => {
		setNavOpen(!document.body.classList.contains("nav-open"));
	});

	// 点击侧边栏和按钮之外的区域 (抽屉遮罩/内容区) 时收起
	document.addEventListener("click", (e) => {
		if (!document.body.classList.contains("nav-open")) return;
		if (e.target.closest("#main-nav") || e.target.closest("#nav-toggle")) return;
		setNavOpen(false);
	});

	// 导航切换后自动收起抽屉 (侧边栏按钮/前进后退都会改 hash)
	window.addEventListener("hashchange", () => setNavOpen(false));
}


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
