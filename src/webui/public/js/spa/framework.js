/**
 * Chirucat WebUI SPA 框架
 *
 * 轻量级单页应用框架, 不依赖任何第三方库, 原生 ES Modules 实现:
 *
 * - 侧边栏 (#main-nav) 按钮根据注册的页面自动生成, 点击切换页面
 * - 页面通过动态 import() 按需加载, 加载期间显示遮罩盖住内容区 (#main)
 * - 使用 hash 路由 (#/page-id), 支持浏览器前进/后退与刷新后定位
 *
 * 页面模块约定 (load() 返回的模块, 默认导出页面对象):
 *
 * ```js
 * export default {
 *   id: "bots",                 // 页面唯一标识, 同时作为 hash 路由段
 *   title: "机器人",            // 页面名, 用于按钮悬停提示
 *   icon: "/img/icons/bot.svg", // 侧边栏按钮图标 (SVG 资源路径)
 *   styles: ["/js/pages/bots/bots.css"], // 可选: 页面专属样式表, 进入时动态加载, 离开时移除
 *   async render(container) {   // 可选: 渲染页面内容到 container (框架提供的页面子容器)
 *     container.textContent = "hello";
 *   },
 *   destroy() { },              // 可选: 页面被切换走时的清理
 * };
 * ```
 *
 * 用法:
 *
 * ```js
 * import { createApp } from "./framework.js";
 * const app = createApp();
 * app.register({ id: "home", title: "首页", icon: "🏠", load: () => import("../pages/home/home.js") });
 * app.start();
 * ```
 */
import { createOverlay } from "./overlay.js";

/**
 * 动态加载一组页面样式表
 *
 * 为每个 URL 创建 <link rel="stylesheet"> 并插入 <head>, 所有样式加载完成
 * (或失败) 后 resolve。样式加载失败不阻塞页面渲染, 只记录警告。返回的 link
 * 元素由框架在页面切换离开时移除, 避免页面样式互相残留。
 *
 * @param {string[]} urls 样式表 URL (页面模块的 styles 字段)
 * @returns {Promise<HTMLLinkElement[]>} 本次创建的 link 元素
 */
function loadStyles(urls) {
	const links = urls.map((href) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		document.head.appendChild(link);
		return link;
	});
	return Promise.all(
		links.map(
			(link) =>
				new Promise((resolve) => {
					link.addEventListener("load", () => resolve(link), { once: true });
					link.addEventListener(
						"error",
						() => {
							console.warn(`[SPA] 加载页面样式失败: ${link.href}`);
							resolve(link); // 样式缺失不阻塞页面渲染
						},
						{ once: true }
					);
				})
		)
	);
}

/**
 * 创建 SPA 应用
 *
 * @param {object} [options]
 * @param {HTMLElement} [options.main] 内容区 #main, 也是遮罩的宿主
 * @param {HTMLElement} [options.root] 页面内容容器, 默认 #page-view
 * @param {HTMLElement} [options.nav] 侧边栏, 默认 #main-nav
 * @param {number} [options.minLoadTime=250] 加载遮罩最小时长(ms), 0 表示不限制
 * @param {number} [options.fadeMs=200] 遮罩淡入/淡出动画时长(ms), 需与 CSS 的 transition 一致
 * @returns {{ register: Function, navigate: Function, start: Function }}
 */
export function createApp(options = {}) {
	const main = options.main ?? document.getElementById("main");
	const root = options.root ?? document.getElementById("page-view");
	const nav = options.nav ?? document.getElementById("main-nav");

	if (!main || !root || !nav) {
		throw new Error("SPA 初始化失败: 页面需要 #main / #page-view / #main-nav 三个元素");
	}

	const minLoadTime = options.minLoadTime ?? 250;
	const fadeMs = options.fadeMs ?? 200;
	const overlay = createOverlay(main, { minShowTime: minLoadTime, fadeMs });

	/** @type {Map<string, { id: string, title: string, icon?: string, load: () => Promise<object> }>} */
	const pages = new Map();
	/** @type {Map<string, HTMLButtonElement>} */
	const buttons = new Map();

	/** @type {{ id: string, page: object, links: HTMLLinkElement[] } | null} 当前打开的页面 */
	let current = null;
	/** 导航序号: 递增, 用于丢弃被后续导航取代的过期加载结果 */
	let navSeq = 0;

	function defaultPageId() {
		for (const id of pages.keys()) return id;
		return null;
	}

	/** 从 location.hash 解析页面 id, 例如 "#/bots" -> "bots" */
	function parseHash() {
		const m = /^#\/([\w-]+)/.exec(location.hash);
		return m ? m[1] : null;
	}

	/** 注册一个页面 */
	function register(pageDef) {
		if (!pageDef || typeof pageDef !== "object") {
			throw new TypeError(`SPA: 页面定义必须是对象, 收到 ${pageDef}`);
		}
		if (typeof pageDef.id !== "string" || pageDef.id.length === 0) {
			throw new Error("SPA: 页面缺少 id");
		}
		if (typeof pageDef.title !== "string" || pageDef.title.length === 0) {
			throw new Error(`SPA: 页面 ${pageDef.id} 缺少 title`);
		}
		if (typeof pageDef.load !== "function") {
			throw new Error(`SPA: 页面 ${pageDef.id} 缺少 load() 加载函数`);
		}
		if (pages.has(pageDef.id)) {
			throw new Error(`SPA: 页面重复注册: ${pageDef.id}`);
		}
		pages.set(pageDef.id, pageDef);
	}

	/** 根据注册的页面渲染侧边栏按钮 */
	function renderNav() {
		nav.replaceChildren();
		buttons.clear();
		for (const def of pages.values()) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "main-nav-btn";
			btn.title = def.title;
			if (def.icon) {
				const img = document.createElement("img");
				img.className = "main-nav-icon";
				img.src = def.icon;
				img.alt = ""; // 装饰性图标, 悬停提示由按钮 title 提供
				img.draggable = false;
				btn.appendChild(img);
			} else {
				btn.textContent = "·"; // 无图标页面的兜底
			}
			btn.addEventListener("click", () => {
				const target = `#/${def.id}`;
				// hash 相同时不会触发 hashchange, 需要手动导航 (视为刷新当前页)
				if (location.hash === target) navigate(def.id);
				else location.hash = target;
			});
			buttons.set(def.id, btn);
			nav.appendChild(btn);
		}
	}

	/** 高亮当前页对应的按钮 */
	function setActive(id) {
		for (const [pid, btn] of buttons) {
			btn.classList.toggle("active", pid === id);
		}
	}

	/**
	 * 切换到指定页面
	 *
	 * 流程: 高亮按钮 -> 显示遮罩 -> 动态加载页面模块 -> 卸载旧页面 ->
	 * 渲染新页面 -> 隐藏遮罩。
	 *
	 * 渲染目标是一个导航专用的子容器 (.spa-page), 而非 #page-view 本身:
	 * 页面 render() 是异步的, 快速切换导航时, 被取代的导航其 render()
	 * 仍可能在稍后才往容器里写入内容; 独立子容器能确保这些过期写入只
	 * 落在已脱离文档的节点上, 随下一次导航的 replaceChildren 一起丢弃,
	 * 不会污染当前页面的内容 (避免页面与导航栏高亮不一致的竞态)。
	 *
	 * @param {string} id 页面 id
	 * @param {{ push?: boolean }} [opts] push=true 时通过修改 hash 导航 (由 hashchange 事件驱动)
	 */
	async function navigate(id, { push = true } = {}) {
		const def = pages.get(id);
		if (!def) {
			console.warn(`[SPA] 未注册的页面: ${id}`);
			return;
		}

		if (push) {
			const target = `#/${id}`;
			if (location.hash !== target) {
				// 交给 hashchange 事件统一驱动, 与浏览器前进/后退行为一致
				location.hash = target;
				return;
			}
			// hash 已相同: 视为刷新当前页, 继续执行
		}

		const seq = ++navSeq;
		setActive(id);
		// 淡入到完全不透明后再切换页面, 避免切换过程被看到
		await overlay.show();
		if (seq !== navSeq) return; // 淡入期间已被更新的导航取代

		/** @type {HTMLLinkElement[]} 本次导航动态加载的页面样式 */
		let links = [];
		try {
			// 按需加载页面模块 (动态 import, 这是"等待加载"的主要来源)
			const mod = await def.load();
			const page = mod.default ?? mod;
			if (seq !== navSeq) return; // 加载期间已被更新的导航取代

			// 动态加载页面专属样式: 渲染前确保样式就位, 避免无样式闪烁 (FOUC)
			links = Array.isArray(page.styles) ? await loadStyles(page.styles) : [];
			if (seq !== navSeq) {
				// 样式加载期间已被更新的导航取代: 移除刚创建的 link, 防止残留
				for (const link of links) link.remove();
				return;
			}

			// 卸载旧页面 (含其动态加载的样式)
			if (current) {
				try {
					current.page.destroy?.();
				} catch (err) {
					console.error(`[SPA] 卸载页面 ${current.id} 时出错:`, err);
				}
				for (const link of current.links ?? []) link.remove();
			}
			current = { id, page, links };

			// 渲染新页面: 每次导航使用独立子容器, 过期的渲染结果只会写入
			// 已脱离文档的节点, 不会污染当前页面的内容
			const view = document.createElement("div");
			view.className = "spa-page";
			root.replaceChildren(view);
			await page.render?.(view);
			if (seq !== navSeq) return; // 渲染期间被更新的导航取代
		} catch (err) {
			if (seq === navSeq) {
				console.error(`[SPA] 加载页面 ${id} 失败:`, err);
				root.replaceChildren();
				const box = document.createElement("div");
				box.className = "page-error";
				const h = document.createElement("h2");
				h.textContent = "页面加载失败";
				const p = document.createElement("p");
				p.textContent = String(err?.message ?? err);
				box.append(h, p);
				root.appendChild(box);
				// 渲染失败: 一并移除本次已加载的样式, 避免页面样式残留
				for (const link of links) link.remove();
				current = null;
			}
		} finally {
			// 页面加载/渲染完成后淡出遮罩 (仅最后一次导航负责隐藏)
			if (seq === navSeq) await overlay.hide();
		}
	}

	/** hash 变化 (前进/后退/手动输入) 时导航到对应页面 */
	function onHashChange() {
		const id = parseHash() ?? defaultPageId();
		if (id) navigate(id, { push: false });
	}

	/** 启动应用: 渲染侧边栏并打开当前 hash 对应的页面 */
	function start() {
		if (pages.size === 0) {
			console.warn("[SPA] 没有注册任何页面");
		}
		renderNav();
		window.addEventListener("hashchange", onHashChange);
		navigate(parseHash() ?? defaultPageId());
	}

	return { register, navigate, start };
}
