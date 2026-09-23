/**
 * WebUI 前端入口
 *
 * 注册各个页面并启动 SPA 框架。
 * 新增页面时, 在下面的 registerPages() 里调用 app.register() 即可,
 * 活动栏按钮会自动生成。
 *
 * 鉴权流程:
 * - 进入页面先请求 /api/auth/verify 查询登录状态
 * - 已登录 (或无密码): 取前端配置 -> 注册页面 -> 显示主界面并启动 SPA
 * - 未登录: 隐藏主界面, 正中显示登录卡片; 登录成功后再走上面那条路径
 * - 任意 API 返回 401 (token 过期/换密码被吊销): 全局切回登录态
 *
 * 注意: 页面注册依赖 /api/get_webui_front_config, 而它声明了 auth: true ——
 * 所以不能把它放在模块顶层 await。否则未登录时该请求 401 抛错, 会让整个模块
 * 中断, 连后面的 showLogin() 都执行不到, 表现为"未鉴权时整页空白"。
 * 现在把注册动作延后到鉴权通过之后, 且配置读取失败也不阻塞进入。
 */
import { createApp } from "./js/spa/framework.js";
import * as auth from "./js/spa/auth.js";
import toast from "./js/spa/toast.js";

const app = createApp({
	main: document.getElementById("main"),
	root: document.getElementById("page-view"),
	nav: document.getElementById("activity-bar"),
	sidebar: document.getElementById("side-bar"),
});

/**
 * 注册全部页面
 *
 * 只有"测试页面"是否注册依赖前端配置, 其余固定注册。
 *
 * @param {{ enableTestLab?: boolean }} config 前端配置 (读取失败时传空对象)
 */
function registerPages(config) {
	app.register({
		id: "home",
		title: "首页",
		icon: "/img/icons/home.svg",
		load: () => import("./js/pages/home/home.js"),
	});

	app.register({
		id: "stats",
		title: "统计",
		icon: "/img/icons/stats.svg",
		load: () => import("./js/pages/stats/stats.js"),
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

	app.register({
		id: "plugins",
		title: "插件",
		icon: "/img/icons/plugin.svg",
		load: () => import("./js/pages/plugins/plugins.js"),
	});

	if (config.enableTestLab) {
		app.register({
			id: "test",
			title: "测试页面",
			icon: "/img/icons/test.svg",
			load: () => import("./js/pages/test/index.js"),
		});
	}

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

/** 是否已完成"取配置 + 注册页面 + 启动 SPA" */
let bootstrapped = false;

/**
 * 进入主界面
 *
 * 首次调用: 取前端配置 -> 注册页面 -> 显示主界面 -> 启动 SPA。
 * 之后调用 (登出后重新登录) 只切回主界面: 重复 app.register() 会抛
 * "页面重复注册", 重复 app.start() 会重跑导航, 都不该发生。
 */
async function enterMain() {
	if (bootstrapped) {
		showMain();
		return;
	}
	bootstrapped = true;

	let config = {};
	try {
		config = await auth.apiFetch("/api/get_webui_front_config").then((r) => r.json());
	} catch (err) {
		// 配置接口失败不应把用户挡在门外: 用默认配置继续进入
		toast(`读取前端配置失败, 使用默认配置: ${err.message}`, { type: "warn" });
	}

	registerPages(config);
	showMain();
	app.start();
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
		await enterMain();
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
		await enterMain();
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
