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
import { initTheme, syncUIStyleFromServer } from "./js/spa/theme.js";

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

	// 界面风格是服务端设置项: 登录后向 webui/config/get 校准一次。
	// 皮肤样式表已由 theme.js 在启动时预加载, 这里只负责取值; 不 await, 不拖慢首屏。
	syncUIStyleFromServer();

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

// ---- 顶栏明暗切换 ----
// 三态循环 (跟随系统 / 浅色 / 深色) 只是「明暗」这一个维度; 界面风格
// (VS Code / Material 3) 是设置页 WebUI 域里的前端设置项, 不占用这个按钮。
// 两个维度如何合成 data-theme, 统一放在 js/spa/theme.js, 设置页保存后也调它。
initTheme();

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
