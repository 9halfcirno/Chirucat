/**
 * Bot 详情窗口的内容
 *
 * 左侧那排图标按钮是**窗口自己的二级导航**, 来源有两处:
 *
 * 1. 核心自带的子页 (`CORE_PAGES`, 见 bot-pages/);
 * 2. 服务插件注册的页面 (`ctx.core.webui.bot.pages.register` → 框架清单里
 *    `scope: "bot"` 的条目)。
 *
 * 两者按 order 合并排序(核心子页的 order 也写在这里, 给插件留出插队的位置),
 * 并且**订阅清单变化**: 服务被停用时, 已经打开的窗口里那一项当场消失 ——
 * 若用户正停在它上面就落到第一项, 而不是留下一张点不动的空菜单。
 *
 * 插件页面的渲染契约: `render(container, bot, app)` —— 容器 + 当前 Bot + SPA 应用
 * 对象。同一份代码服务于任意 Bot, 不要在插件里写死某个 bot id。
 */
import { createIconButton } from "../../spa/components/icon-button.js";
import { attachTooltip } from "../../spa/components/tooltip.js";
import { getApp } from "../../spa/framework.js";
import { getServicePages } from "../../spa/service-pages.js";

/**
 * 核心自带的子页
 *
 * order 是给服务插件页面留位置用的: 插件注册时可以给 30 这类值插到中间,
 * 设置页固定排在最后 (90)。
 */
const CORE_PAGES = [
	{ url: "./bot-pages/info.js", order: 10 },
	{ url: "./bot-pages/plugins.js", order: 20 },
	{ url: "./bot-pages/setting.js", order: 90 },
];

/**
 * 创建bot的弹窗内容
 * @param {{ name: string, id: string }} bot Bot ID
 */
export function createBotContent(bot) {
	const div = document.createElement("div");
	div.classList.add("bot-div");

	const botNav = document.createElement("nav"); // bot侧边导航栏
	botNav.classList.add("bot-nav");
	div.append(botNav);

	const botMain = document.createElement("div");
	botMain.classList.add("bot-main");
	div.append(botMain);

	const app = getApp();

	/**
	 * 菜单项: key → { key, title, icon, styles, order, seq, render }
	 * Map 的插入顺序只是兜底, 真正的顺序按 (order, seq) 排。
	 */
	const entries = new Map();
	let seq = 0;
	/** 当前选中的项; null 表示没有可选项 */
	let activeKey = null;
	let closed = false;
	/** 菜单项按钮: key → button (随 paintMenu 重建) */
	const buttons = new Map();

	/** 建一个菜单项 (核心子页与服务插件页面共用) */
	function addEntry({ key, title, icon, styles, order, render }) {
		entries.set(key, { key, title, icon, styles, order: order ?? 100, seq: ++seq, render });
	}

	/** 排在界面上的顺序: order 升序, 同 order 保持加入顺序 */
	function ordered() {
		return [...entries.values()].sort((a, b) => a.order - b.order || a.seq - b.seq);
	}

	function syncHighlight() {
		for (const [key, btn] of buttons) btn.classList.toggle("show", key === activeKey);
	}

	/** 重绘左侧按钮 (增删菜单项后调用) */
	function paintMenu() {
		buttons.clear();
		botNav.replaceChildren();
		for (const entry of ordered()) {
			const btn = createIconButton(entry.icon ?? "/img/icons/cube.svg", () => select(entry.key));
			btn.setAttribute("aria-label", entry.title);
			attachTooltip(btn, entry.title);
			buttons.set(entry.key, btn);
			botNav.append(btn);
		}

		// 选中的项没了(服务停用): 落到第一项; 一项都没有就清空内容区
		if (activeKey && !entries.has(activeKey)) activeKey = null;
		if (!activeKey) {
			const first = ordered()[0];
			if (first) select(first.key);
			else botMain.replaceChildren();
			return;
		}
		syncHighlight();
	}

	/** 打开某一项 */
	function select(key) {
		const entry = entries.get(key);
		if (!entry) {
			botMain.replaceChildren();
			return;
		}

		activeKey = key;
		syncHighlight();
		ensureStyles(entry.styles);
		botMain.replaceChildren();
		entry.render(botMain, bot, app);
	}

	// ---- 服务插件注册的页面 ----
	/** 把清单里的 bot 作用域条目同步进来 (多退少补, 只动服务来源的项) */
	function applyServiceEntries() {
		const views = getServicePages()?.botPages() ?? [];
		const wanted = new Set(views.map((view) => `svc:${view.key}`));

		for (const key of [...entries.keys()]) {
			if (key.startsWith("svc:") && !wanted.has(key)) entries.delete(key);
		}
		for (const view of views) {
			addEntry({
				key: `svc:${view.key}`,
				title: view.title,
				icon: view.icon,
				styles: view.styles,
				order: view.order,
				// 每次同步都换新的 render 闭包: 模块 URL 变了(服务重新注册)要 import 新的
				render: (main, botArg, appArg) => renderServiceEntry(view.module, main, botArg, appArg),
			});
		}
	}

	/** 渲染一个服务插件页面 (默认导出函数, 或带 render 的对象) */
	async function renderServiceEntry(url, main, botArg, appArg) {
		try {
			const mod = await import(url);
			const entry = mod?.default ?? mod;
			if (typeof entry === "function") {
				await entry(main, botArg, appArg);
				return;
			}
			if (entry && typeof entry.render === "function") {
				await entry.render(main, botArg, appArg);
				return;
			}
			main.textContent = "该插件页面没有导出可渲染的内容 (需要默认导出一个函数或 { render })";
		} catch (err) {
			// 服务在这一瞬间被停用、或插件模块本身有错: 给出可见的原因而不是空白
			console.error(`[SPA] 加载插件 Bot 页面失败: ${url}`, err);
			const tip = document.createElement("p");
			tip.className = "muted";
			tip.textContent = `加载失败: ${err?.message ?? err}`;
			main.replaceChildren(tip);
		}
	}

	// 订阅清单变化: 服务启停后, 已经打开的窗口要跟着增删菜单
	const unsubscribe = getServicePages()?.subscribe(() => {
		if (closed) return;
		applyServiceEntries();
		paintMenu();
	}) ?? null;

	/** 收尾: 窗口关掉后别再响应清单变化 */
	div.disposeBotContent = () => {
		closed = true;
		unsubscribe?.();
	};

	// 先加载核心子页, 再合并服务插件页面并画出来 (与旧的逐个 addPage 等价, 只是有了顺序与来源)
	void (async () => {
		for (const { url, order } of CORE_PAGES) {
			try {
				const module = (await import(url)).default;
				addEntry({
					key: `core:${url}`,
					title: module.title,
					icon: module.icon,
					styles: module.styles,
					order,
					render: (main, botArg) => module.render(main, botArg),
				});
			} catch (err) {
				console.error(`[SPA] 加载 Bot 子页失败: ${url}`, err);
			}
		}

		if (closed) return;
		applyServiceEntries();
		paintMenu();
	})();

	return div;
}

/**
 * 按需插入子页声明的样式表
 *
 * framework.js 里的页面样式会随导航卸载, 弹窗子页则只做一次幂等插入 ——
 * 弹窗生命周期短, 卸载回来还要重插, 收益不值当。
 * @param {string[]} [urls]
 */
function ensureStyles(urls) {
	for (const url of urls ?? []) {
		if (document.head.querySelector(`link[rel="stylesheet"][href="${url}"]`)) continue;

		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		document.head.appendChild(link);
	}
}
