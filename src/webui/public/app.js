/**
 * WebUI 前端入口
 *
 * 注册各个页面并启动 SPA 框架。
 * 新增页面时, 在这里调用 app.register() 即可, 侧边栏按钮会自动生成。
 */
import { createApp } from "./js/spa/framework.js";

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

app.start();

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
