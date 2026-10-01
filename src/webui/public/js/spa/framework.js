/**
 * Chirucat WebUI SPA 框架
 *
 * 轻量级单页应用框架, 不依赖任何第三方库, 原生 ES Modules 实现:
 *
 * - 一级导航: 活动栏 (#activity-bar) 按钮由注册的页面生成, 点击切换页面
 * - 二级菜单: 侧栏 (#side-bar) 的菜单项由页面声明, 或运行期动态增删
 * - 页面通过动态 import() 按需加载, 加载期间显示遮罩盖住内容区 (#main)
 * - 使用 hash 路由 (#/page-id), 支持浏览器前进/后退与刷新后定位
 *
 * ## 页面模块约定 (load() 返回的模块, 默认导出页面对象)
 *
 * ```js
 * export default {
 *   id: "bots",                 // 页面唯一标识, 同时作为 hash 路由段
 *   title: "机器人",            // 页面名: 按钮的可访问名 + 悬停时右侧弹出的提示
 *   icon: "/img/icons/bot.svg", // 活动栏按钮图标 (SVG 资源路径, 以 mask 渲染并跟随主题色)
 *   styles: ["/js/pages/bots/bots.css"], // 可选: 页面专属样式表, 进入时动态加载, 离开时移除
 *   async render(container, app) { } // 可选: 渲染页面内容到 container (框架提供的页面子容器)
 *   sidebar: [                  // 可选: 二级菜单项, 框架渲染侧栏并处理切换
 *     { title: "项一", render(container, app) { } },
 *     "分组标题",                // 字符串 = 不可点击的文本项
 *   ],                          // 未提供或为空则侧栏隐藏, 内容区占满
 *   destroy() { },              // 可选: 页面被切换走或被注销时的清理
 * };
 * ```
 *
 * ## 动态增删 (运行期)
 *
 * 一级导航与二级菜单都可以在运行期增删, 不必挤在启动时的那一次注册里 ——
 * 插件/服务在拿到自己的页面后随时可以注册, 也能按需挂上二级菜单:
 *
 * ```js
 * const app = createApp();
 * app.register({ id: "home", title: "首页", icon: "🏠", load: () => import("../pages/home/home.js") });
 * app.start();
 *
 * // --- 之后任何时候 ---
 * app.register({                 // 一级导航: 新增 (也可以直接给 render 做内联页面)
 *   id: "filter", title: "过滤", render: (el) => { el.textContent = "…"; },
 * });
 * app.update("filter", { title: "黑白名单", icon: "/img/icons/shield.svg" }); // 改标题/图标/顺序
 * app.unregister("filter");      // 一级导航: 删除 (正开着就落到第一个页面)
 *
 * app.sidebar.add({ title: "规则", render: (el) => { } });          // 二级菜单: 加到当前页面
 * app.sidebar.add({ title: "日志", render: (el) => { } }, { page: "filter" }); // 指定页面
 * app.sidebar.remove("规则");     // 二级菜单: 删除 (id / 下标 / 定义对象都行)
 * app.sidebar.set([{ title: "A", render() { } }]);  // 整表替换 (声明式 sidebar 让位)
 * app.sidebar.reset();           // 丢掉本页动态状态, 回到页面声明的菜单
 * app.sidebar.select("A");       // 选中某一项
 * ```
 *
 * 动态菜单按**页面 id** 记账 (见 sidebar.js): 页面没开着时先记下, 下次打开一并
 * 渲染; 同一 id 视为同一条菜单, 再 add 即更新它。二级菜单不进路由, 地址栏始终
 * 只反映一级页面。
 *
 * 页面之外的脚本 (例如插件自带的前端资源) 可以用 `getApp()` 拿到这个应用对象:
 *
 * ```js
 * import { getApp } from "/js/spa/framework.js";
 * getApp()?.sidebar.add({ title: "我的面板", render: (el) => { } });
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
import { createSidebar } from "./sidebar.js";
import { attachTooltip } from "./components/tooltip.js";

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

/** 最近一次 createApp() 建出的应用实例 (全站只有一个) */
let sharedApp = null;

/**
 * 取当前 SPA 应用实例
 *
 * 给"没有拿到 app 引用"的脚本用: 插件前端资源与页面模块处在同一个模块图里,
 * import 同一个 URL (`/js/spa/framework.js`) 拿到的就是同一个实例。
 * 应用还没创建时返回 null。
 *
 * @returns {object | null}
 */
export function getApp() {
	return sharedApp;
}

/**
 * 创建 SPA 应用
 *
 * @param {object} [options]
 * @param {HTMLElement} [options.main] 内容区 #main, 也是遮罩的宿主
 * @param {HTMLElement} [options.root] 页面内容容器, 默认 #page-view
 * @param {HTMLElement} [options.nav] 活动栏 (一级导航), 默认 #activity-bar
 * @param {HTMLElement | null} [options.sidebar] 次级侧栏, 默认 #side-bar
 * @param {number} [options.minLoadTime=250] 加载遮罩最小时长(ms), 0 表示不限制
 * @param {number} [options.fadeMs=200] 遮罩淡入/淡出动画时长(ms), 需与 CSS 的 transition 一致
 * @param {number} [options.sidebarAnimMs=280] 窄屏折叠菜单的高度动画时长(ms), 需与 CSS 的 --dur-slow 一致
 * @returns {{
 *   register: (pageDef: object, opts?: { index?: number }) => object,
 *   update: (id: string, patch: object) => object,
 *   unregister: (id: string) => boolean,
 *   hasPage: (id: string) => boolean,
 *   getPage: (id: string) => object | undefined,
 *   listPages: () => Array<{ id: string, title: string, icon?: string }>,
 *   navigate: (id: string, opts?: { push?: boolean }) => Promise<void>,
 *   start: () => object,
 *   sidebar: object,
 * }}
 */
export function createApp(options = {}) {
	const main = options.main ?? document.getElementById("main");
	const root = options.root ?? document.getElementById("page-view");
	const nav = options.nav ?? document.getElementById("activity-bar");
	const sideBar = options.sidebar ?? document.getElementById("side-bar");

	if (!main || !root || !nav) {
		throw new Error("SPA 初始化失败: 页面需要 #main / #page-view / #activity-bar 三个元素");
	}

	nav.onselectstart = (e) => { e.preventDefault(); return false };

	const minLoadTime = options.minLoadTime ?? 250;
	const fadeMs = options.fadeMs ?? 200;
	const overlay = createOverlay(main, { minShowTime: minLoadTime, fadeMs });

	// 次级侧栏: 菜单来源与运行期增删见 sidebar.js (窄屏下的折叠菜单也在那里)
	// 页面上没有 #side-bar 时传 null: 控制器照样记账, 只是不渲染, 布局退化为无侧栏
	const sidebar = createSidebar({ container: sideBar ?? null, main, animMs: options.sidebarAnimMs ?? 280 });

	/** @type {Map<string, { id: string, title: string, icon?: string, load?: () => Promise<object> }>} */
	const pages = new Map();
	/** @type {Map<string, HTMLButtonElement>} */
	const buttons = new Map();
	/** @type {Array<() => void>} 各按钮的浮窗解绑函数, 重建导航时先解绑旧的 */
	const detachTooltips = [];

	/** @type {{ id: string, page: object, links: HTMLLinkElement[] } | null} 当前打开的页面 */
	let current = null;
	/** 导航序号: 递增, 用于丢弃被后续导航取代的过期加载结果 */
	let navSeq = 0;
	/** start() 是否已经跑过: 之后注册/注销的页面要即时反映到活动栏上 */
	let started = false;

	function defaultPageId() {
		for (const id of pages.keys()) return id;
		return null;
	}

	/** 从 location.hash 解析页面 id, 例如 "#/bots" -> "bots" */
	function parseHash() {
		const m = /^#\/([\w-]+)/.exec(location.hash);
		return m ? m[1] : null;
	}

	/** 改写地址栏里的页面段, 但不新增历史记录 (注销当前页面时用) */
	function replaceHash(id) {
		const target = `#/${id}`;
		if (location.hash !== target) history.replaceState(null, "", target);
	}

	/** 把页面移到指定顺序位 (一级导航的排列顺序) */
	function reorder(id, index) {
		const entries = [...pages.entries()];
		const from = entries.findIndex(([pid]) => pid === id);
		if (from < 0) return;

		const [entry] = entries.splice(from, 1);
		const at = Math.max(0, Math.min(Math.trunc(index), entries.length));
		entries.splice(at, 0, entry);

		pages.clear();
		for (const [pid, pageDef] of entries) pages.set(pid, pageDef);
	}

	/**
	 * 注册一个页面 (一级导航项)
	 *
	 * 既可以在 start() 之前批量注册, 也可以在之后随时调用 —— 之后调用会立即
	 * 反映到活动栏上; 若此刻的 hash 正指向这个页面 (深链先到、页面后注册),
	 * 注册完就直接把它打开。
	 *
	 * @param {object} pageDef 页面定义
	 * @param {{ index?: number }} [opts] index: 插到第几位 (缺省追加到末尾)
	 * @returns {object} 应用对象 (可链式调用)
	 */
	function register(pageDef, { index = -1 } = {}) {
		if (!pageDef || typeof pageDef !== "object") {
			throw new TypeError(`SPA: 页面定义必须是对象, 收到 ${pageDef}`);
		}
		if (typeof pageDef.id !== "string" || pageDef.id.length === 0) {
			throw new Error("SPA: 页面缺少 id");
		}
		if (typeof pageDef.title !== "string" || pageDef.title.length === 0) {
			throw new Error(`SPA: 页面 ${pageDef.id} 缺少 title`);
		}
		if (typeof pageDef.load !== "function" && typeof pageDef.render !== "function") {
			throw new Error(`SPA: 页面 ${pageDef.id} 缺少 load() 加载函数 (或直接提供 render() 作内联页面)`);
		}
		if (pages.has(pageDef.id)) {
			throw new Error(`SPA: 页面重复注册: ${pageDef.id} (改标题/图标请用 update)`);
		}

		pages.set(pageDef.id, pageDef);
		if (index >= 0) reorder(pageDef.id, index);

		if (started) {
			renderNav();
			const wanted = parseHash();
			if (wanted === pageDef.id) {
				// 之前访问过这个深链 (那时页面还没注册): 现在补上
				void navigate(pageDef.id, { push: false });
			} else if (!wanted && !current) {
				// 启动时一个页面都没有, 现在有了第一个: 打开它
				void navigate(pageDef.id);
			}
		}
		return api;
	}

	/**
	 * 改一个已注册页面的定义 (标题 / 图标 / 顺序 / 加载器等)
	 *
	 * @param {string} id 页面 id
	 * @param {object} patch 补丁; `index` 用于调整在活动栏里的顺序
	 * @returns {object} 应用对象 (可链式调用)
	 */
	function update(id, patch) {
		const def = pages.get(id);
		if (!def) throw new Error(`SPA: 未注册的页面: ${id}`);
		if (!patch || typeof patch !== "object") throw new TypeError("SPA: update() 需要一个补丁对象");

		const { index, ...fields } = patch;
		if (fields.id !== undefined && fields.id !== id) {
			throw new Error(`SPA: 页面 id 不可修改: ${id}`);
		}
		delete fields.id;
		if (fields.title !== undefined && (typeof fields.title !== "string" || fields.title.length === 0)) {
			throw new Error(`SPA: 页面 ${id} 的 title 必须是非空字符串`);
		}
		for (const key of ["icon", "load", "render", "styles"]) {
			const value = fields[key];
			if (value === undefined) continue;
			const ok = key === "styles" ? Array.isArray(value) : typeof value === (key === "load" || key === "render" ? "function" : "string");
			if (!ok) throw new Error(`SPA: 页面 ${id} 的 ${key} 类型不对`);
		}

		Object.assign(def, fields);
		// 注意: 正在显示的页面不会被重新加载 —— 改动从下次进入该页面起生效
		if (index !== undefined) reorder(id, index);
		if (started) renderNav();
		return api;
	}

	/**
	 * 注销一个页面 (一级导航项), 连同它的二级菜单动态状态
	 *
	 * 注销的正是当前页面时: 卸载它 (destroy + 移除样式), 落到剩下的第一个页面,
	 * 并把地址栏里的页面段一并改写 (不新增历史记录)。
	 *
	 * @param {string} id 页面 id
	 * @returns {boolean} 是否真的注销了一个页面
	 */
	function unregister(id) {
		if (!pages.has(id)) return false;

		pages.delete(id);
		// 页面没了, 它的菜单表也不该再重建 (restore=false); 界面交给接下来的导航
		sidebar.drop(id, { restore: false });
		renderNav();

		if (current?.id === id) {
			navSeq++; // 作废在途的导航, 免得它把已注销的页面又渲染回来
			unmountCurrent();
			root.replaceChildren();

			const fallback = defaultPageId();
			if (fallback) {
				replaceHash(fallback);
				void navigate(fallback, { push: false });
			} else {
				sidebar.clear();
				if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
			}
		}
		return true;
	}

	/** 页面是否已注册 */
	function hasPage(id) {
		return pages.has(id);
	}

	/** 取页面定义 (未注册返回 undefined) */
	function getPage(id) {
		return pages.get(id);
	}

	/** 已注册页面的摘要, 按一级导航顺序 */
	function listPages() {
		return [...pages.values()].map(({ id, title, icon }) => ({ id, title, icon }));
	}

	/** 根据注册的页面渲染侧边栏按钮 */
	function renderNav() {
		// 重建前先解绑旧按钮的浮窗: 旧按钮随 replaceChildren 废弃, 若它上面
		// 还挂着正在显示的提示, 提示会停在一个已不存在的锚点旁
		for (const detach of detachTooltips.splice(0)) detach();

		nav.replaceChildren();
		buttons.clear();
		for (const def of pages.values()) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "activity-btn";
			// 原生 title 换成了自绘浮窗 (位置由浏览器定的原生提示会压在按钮上,
			// 而这里要的是 VS Code 那样出现在按钮右侧), 可访问名得自己补上
			btn.setAttribute("aria-label", def.title);
			detachTooltips.push(attachTooltip(btn, () => def.title));
			if (def.icon) {
				// mask 图标: 颜色跟随 currentColor, 从而适配深浅主题 (见 base.css 的 .icon)
				const icon = document.createElement("span");
				icon.className = "icon";
				icon.style.setProperty("--icon", `url("${def.icon}")`);
				btn.appendChild(icon);
			} else {
				btn.textContent = "·"; // 无图标页面的兜底
			}
			btn.addEventListener("click", () => {
				const target = `#/${def.id}`;
				// hash 相同时不会触发 hashchange, 需要手动导航 (视为刷新当前页)
				if (location.hash === target) void navigate(def.id);
				else location.hash = target;
			});
			buttons.set(def.id, btn);
			nav.appendChild(btn);
		}

		// 重建后恢复高亮 (新按钮没有 active 类)
		setActive(current?.id ?? parseHash());
	}

	/** 高亮当前页对应的按钮 */
	function setActive(id) {
		for (const [pid, btn] of buttons) {
			btn.classList.toggle("active", pid === id);
		}
	}

	/**
	 * 取页面模块
	 *
	 * 常规页面给 load() (动态 import, 也是"等待加载"的主要来源); 动态注册的
	 * 小页面可以直接给 render(), 这时页面定义本身就是页面模块。
	 *
	 * @param {object} def 页面定义
	 * @returns {Promise<object>} 页面模块
	 */
	async function loadPage(def) {
		if (typeof def.load === "function") {
			const mod = await def.load();
			return mod?.default ?? mod;
		}
		return def;
	}

	/** 卸载当前页面: 清理钩子 + 移除它动态加载的样式 */
	function unmountCurrent() {
		if (!current) return;
		try {
			current.page.destroy?.();
		} catch (err) {
			console.error(`[SPA] 卸载页面 ${current.id} 时出错:`, err);
		}
		for (const link of current.links ?? []) link.remove();
		current = null;
	}

	/**
	 * 渲染当前页面的次级侧栏
	 *
	 * 页面通过 sidebar 数组声明二级菜单项 (也可以在 render 里改它, 或用
	 * app.sidebar.* 运行期增删), 由 sidebar.js 渲染并处理点击切换。没有菜单项
	 * 时整块隐藏 (body.nav-collapsed), 内容区占满。
	 *
	 * @param {object} page 页面模块
	 * @param {HTMLElement} view 页面容器, 作为菜单项内容的落点
	 * @param {string} id 页面在框架里的注册 id (页面模块未必声明 id, 菜单要按它记账)
	 */
	async function renderSideBar(page, view, id) {
		await sidebar.render(page, view, api, id);
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
			// 页面还没注册 (深链先到 / 页面已被注销): 先落到第一个页面, 但**不动地址栏** ——
			// 页面稍后注册上来时 register() 会按 hash 把它接上
			console.warn(`[SPA] 未注册的页面: ${id}`);
			const fallback = defaultPageId();
			if (!fallback || fallback === id) return;
			if (current?.id === fallback) return; // 已经站在兜底页面上了, 不必重渲一遍
			return navigate(fallback, { push: false });
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
			const page = await loadPage(def);
			if (seq !== navSeq) return; // 加载期间已被更新的导航取代

			// 动态加载页面专属样式: 渲染前确保样式就位, 避免无样式闪烁 (FOUC)
			links = Array.isArray(page.styles) ? await loadStyles(page.styles) : [];
			if (seq !== navSeq) {
				// 样式加载期间已被更新的导航取代: 移除刚创建的 link, 防止残留
				for (const link of links) link.remove();
				return;
			}

			unmountCurrent();
			current = { id, page, links };

			// 渲染新页面: 每次导航使用独立子容器, 过期的渲染结果只会写入
			// 已脱离文档的节点, 不会污染当前页面的内容
			const view = document.createElement("div");
			view.className = "spa-page";
			root.replaceChildren(view);
			// 第二个参数是应用对象: 页面据此在 render 里动态增删二级菜单
			await page.render?.(view, api);
			if (seq !== navSeq) return; // 渲染期间被更新的导航取代

			// 次级侧栏: 页面可选声明 sidebar 数组 (render 之后才读, 因此页面
			// 可以在 render 里按后端数据重写它 —— 设置页就是这么做的)
			await renderSideBar(page, view, id);
			if (seq !== navSeq) return;
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
		if (id) void navigate(id, { push: false });
	}

	/** 启动应用: 渲染侧边栏并打开当前 hash 对应的页面 */
	function start() {
		if (started) {
			// 重复启动: 只把活动栏同步到最新的页面表, 不重跑导航
			renderNav();
			return api;
		}
		started = true;

		if (pages.size === 0) {
			console.warn("[SPA] 没有注册任何页面");
		}
		renderNav();
		window.addEventListener("hashchange", onHashChange);

		const id = parseHash() ?? defaultPageId();
		if (id) void navigate(id);
		return api;
	}

	/** 把 opts.page 解析成页面 id: 缺省用当前打开的页面 */
	function sidebarPageId(opts) {
		const id = opts?.page ?? current?.id ?? null;
		if (!id) {
			throw new Error("SPA: 二级菜单操作需要指定页面 (当前没有打开的页面, 请传 { page: \"<页面id>\" })");
		}
		return id;
	}

	/**
	 * 二级菜单的运行期增删接口
	 *
	 * 全部按页面 id 记账: 不传 `{ page }` 时作用于当前打开的页面。页面 id 必须
	 * 是注册过的页面才有意义 (菜单在该页面打开时渲染)。
	 */
	const sidebarAPI = {
		/**
		 * 新增或更新一条菜单项
		 * @param {string | object} item 菜单项 (title/render, 或字符串文本项)
		 * @param {{ page?: string, index?: number }} [opts]
		 * @returns {object | null} 规范化后的项 (可交给 remove / select)
		 */
		add(item, opts = {}) {
			return sidebar.add(sidebarPageId(opts), item, opts.index ?? -1);
		},
		/**
		 * 删除一条菜单项 (id / 下标 / add 返回的对象都行)
		 * @param {number | string | object} target
		 * @param {{ page?: string }} [opts]
		 * @returns {boolean}
		 */
		remove(target, opts = {}) {
			return sidebar.remove(sidebarPageId(opts), target);
		},
		/**
		 * 整表替换一个页面的菜单 (页面自己声明的 sidebar 从此让位)
		 * @param {unknown} items 菜单项数组
		 * @param {{ page?: string }} [opts]
		 * @returns {object[]}
		 */
		set(items, opts = {}) {
			return sidebar.set(sidebarPageId(opts), items);
		},
		/**
		 * 丢掉一个页面的动态菜单状态, 回到页面声明的菜单
		 * @param {{ page?: string }} [opts]
		 */
		reset(opts = {}) {
			sidebar.drop(sidebarPageId(opts));
		},
		/**
		 * 查一个页面当前的菜单 (声明 + 动态)
		 * @param {{ page?: string }} [opts]
		 * @returns {object[]}
		 */
		list(opts = {}) {
			return sidebar.list(sidebarPageId(opts));
		},
		/**
		 * 选中一条菜单项 (页面没开着时记下, 等它打开再选)
		 * @param {number | string | object} target
		 * @param {{ page?: string }} [opts]
		 * @returns {Promise<object | null>}
		 */
		select(target, opts = {}) {
			return sidebar.select(sidebarPageId(opts), target);
		},
		/**
		 * 重新读取页面模块声明的 sidebar 并刷新 (页面在 render 之后又改了它时用)
		 * @param {{ page?: string }} [opts]
		 * @returns {object[]}
		 */
		refresh(opts = {}) {
			return sidebar.refresh(sidebarPageId(opts));
		},
		/** 当前打开的页面 id (没有页面时为 null) */
		currentPageId: () => sidebar.currentPageId(),
	};

	const api = {
		register,
		update,
		unregister,
		hasPage,
		getPage,
		listPages,
		navigate,
		start,
		sidebar: sidebarAPI,
	};

	sharedApp = api;
	return api;
}
