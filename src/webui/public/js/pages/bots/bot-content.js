/**
 * Bot 详情窗口的内容
 *
 * 左侧那排图标按钮是**窗口自己的二级导航**, 来源有两处:
 *
 * 1. 核心自带的子页 (`CORE_PAGES`, 见 bot-pages/) —— 恒在;
 * 2. 清单里的 `scope: "bot"` 条目 —— 服务插件注册的页面, 以及核心的可选
 *    Bot 子页 (如统计页)。它们跟着模块开关/服务启停一起出现或消失。
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
	{ url: "./bot-pages/logs.js", order: 30 },
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
	/** 当前页面的清理函数 (render 的返回值); 切页/关窗时先调用 */
	let disposeActive = null;

	/** 建一个菜单项 (核心子页与清单页面共用) */
	/**
	 * 建一个菜单项 (核心子页与清单页面共用)
	 *
	 * `tier` 是同 order 时的打平手顺序: 0 = 核心 (自带子页 / 核心可选页),
	 * 1 = 服务插件页。WebUI 一级导航里统计页靠 `before` 锚点就一定在服务插件
	 * 页之前; Bot 窗口没有锚点, 只靠 order, 所以撞车时需要这个来源优先级,
	 * 否则“先加入的在上”会让结果依赖遍历顺序。
	 *
	 * 注意它只在 order 相等时生效 —— 插件仍可靠更小的 order 插到核心页之前。
	 */
	function addEntry({ key, title, icon, styles, order, tier = 0, render }) {
		entries.set(key, { key, title, icon, styles, order: order ?? 100, tier, seq: ++seq, render });
	}

	/** 排在界面上的顺序: order 升序 → 同 order 核心先于插件 → 同组保持加入顺序 */
	function ordered() {
		return [...entries.values()].sort(
			(a, b) => a.order - b.order || a.tier - b.tier || a.seq - b.seq,
		);
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

	/**
	 * 打开某一项
	 *
	 * 子页可以返回一个清理函数 (如日志页要关掉 EventSource): 切走或关窗时调用。
	 * 插件页的 render 是 async, 返回的是 Promise —— 等它落定再接管, 期间若已切走
	 * 就立即清理, 不留一个没人管的连接。
	 */
	function select(key) {
		// 先收尾上一页: 它可能持有 SSE 连接 / 定时器
		const previous = disposeActive;
		disposeActive = null;
		if (typeof previous === "function") previous();

		const entry = entries.get(key);
		if (!entry) {
			botMain.replaceChildren();
			return;
		}

		activeKey = key;
		syncHighlight();
		ensureStyles(entry.styles);
		botMain.replaceChildren();

		const result = entry.render(botMain, bot, app);
		adoptDisposer(result, key);
	}

	/**
	 * 接管子页返回的清理函数 (同步返回或 Promise 均可)
	 *
	 * 渲染期间用户可能已经切到别的项: 那种情况下立即清理, 不能把它存成
	 * 当前页面的 dispose —— 否则下次切页会漏掉这个连接。
	 * @param {unknown} result render 的返回值
	 * @param {string} key 发起渲染的菜单项
	 */
	function adoptDisposer(result, key) {
		if (result && typeof result.then === "function") {
			result.then(
				(fn) => takeDisposer(fn, key),
				() => { /* 渲染失败已由各自页面展示 */ },
			);
			return;
		}
		takeDisposer(result, key);
	}

	function takeDisposer(fn, key) {
		if (typeof fn !== "function") return;
		// 渲染期间已切走 / 窗口已关: 直接收尾
		if (closed || activeKey !== key) {
			fn();
			return;
		}
		disposeActive = fn;
	}

	// ---- 清单注册的页面 (服务插件页 + 核心可选页) ----
	/**
	 * 把清单里的 bot 作用域条目同步进来 (多退少补, 只动清单来源的项)
	 *
	 * 统计页就走这条路: 它是可选模块, 关闭后服务器清单里不再有这条
	 * (`scope: "bot"` 的 corePage), 对账时这里就把它从菜单里摘掉 —— 与整站
	 * 统计页用同一套机制, 不需要在窗口里另写一份开关判断。
	 */
	function applyManifestEntries() {
		const views = getServicePages()?.botPages() ?? [];
		const wanted = new Set(views.map((view) => `manifest:${view.key}`));

		for (const key of [...entries.keys()]) {
			if (key.startsWith("manifest:") && !wanted.has(key)) entries.delete(key);
		}
		for (const view of views) {
			addEntry({
				key: `manifest:${view.key}`,
				title: view.title,
				icon: view.icon,
				styles: view.styles,
				order: view.order,
				// 核心可选页与服务插件页同 order 时, 前者在前 (与一级导航一致)
				tier: view.source === "core" ? 0 : 1,
				// 每次同步都换新的 render 闭包: 模块 URL 变了(服务重新注册)要 import 新的
				render: (main, botArg, appArg) => renderManifestEntry(view.module, main, botArg, appArg),
			});
		}
	}

	/**
	 * 渲染一个清单页面 (默认导出函数, 或带 render 的对象)
	 *
	 * 透传子页的返回值: 它可能是一个清理函数 (如统计页要停定时器、释放图表),
	 * 由 select() 接管并在切页/关窗时调用。async 函数会把清理函数包进 Promise,
	 * adoptDisposer 已兼容这种形状。
	 */
	async function renderManifestEntry(url, main, botArg, appArg) {
		try {
			const mod = await import(url);
			const entry = mod?.default ?? mod;

			// 模块自己声明的样式一并挂上: 清单条目上的 styles 只是入口声明,
			// 子页把 ``styles`` 写在模块里才是它的自然位置 (与服务插件模块一致)。
			// 两处都插是幂等的 (ensureStyles 会查重), 少一处都不至于裸样式。
			if (Array.isArray(entry?.styles)) ensureStyles(entry.styles);

			if (typeof entry === "function") {
				return await entry(main, botArg, appArg);
			}
			if (entry && typeof entry.render === "function") {
				return await entry.render(main, botArg, appArg);
			}
			main.textContent = "该插件页面没有导出可渲染的内容 (需要默认导出一个函数或 { render })";
		} catch (err) {
			// 服务在这一瞬间被停用、或插件模块本身有错: 给出可见的原因而不是空白
			console.error(`[SPA] 加载 Bot 页面失败: ${url}`, err);
			const tip = document.createElement("p");
			tip.className = "muted";
			tip.textContent = `加载失败: ${err?.message ?? err}`;
			main.replaceChildren(tip);
		}
	}

	// 订阅清单变化: 服务启停后, 已经打开的窗口要跟着增删菜单
	const unsubscribe = getServicePages()?.subscribe(() => {
		if (closed) return;
		applyManifestEntries();
		paintMenu();
	}) ?? null;

	/** 收尾: 窗口关掉后别再响应清单变化, 并释放当前子页 (如日志页的 SSE 连接) */
	div.disposeBotContent = () => {
		closed = true;
		unsubscribe?.();
		const dispose = disposeActive;
		disposeActive = null;
		if (typeof dispose === "function") dispose();
	};

	// 先加载核心子页, 再合并清单页面并画出来 (与旧的逐个 addPage 等价, 只是有了顺序与来源)
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
		applyManifestEntries();
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
