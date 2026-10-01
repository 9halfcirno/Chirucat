/**
 * 次级侧栏 (#side-bar) — 二级菜单
 *
 * 二级菜单有两个来源, 可以混用:
 *
 * 1. **声明式**: 页面模块的 `sidebar` 数组, 每次打开该页面时读一次
 *    (页面也可以在自己的 render() 里改写 `this.sidebar`, 例如设置页按后端的域生成)
 * 2. **命令式**: 运行期调用 add / remove / set / list / select / refresh / drop ——
 *    由 framework 暴露成 `app.sidebar.*`, 于是页面、插件或任意脚本都能在运行时增删菜单
 *
 * 菜单项的形状:
 *
 * ```js
 * { id?: "filter", title: "过滤规则", render(container, app) { ... } }
 * "分组标题"   // 字符串 = 不可点击的文本项
 * ```
 *
 * `id` 缺省取 `title`; 同 id 视为同一条菜单 —— 再 add 一次就是更新它 (位置不变)。
 *
 * 动态状态按**页面 id** 记在菜单表里 (`menus`), 因此:
 *
 * - 页面正开着: 增删立即反映到界面 (按钮列表就地重建, 选中项按 id 保留)
 * - 页面没开着: 先记下, 等它下次打开时一并渲染 —— 注册方不必关心当前在哪个页面
 * - remove 会记住被删掉的 id (抑制表 suppressed): 页面重新声明 sidebar 时
 *   (如设置页每次打开都重建声明), 被删掉的项不会自己冒回来; 再 add 同 id 即撤销删除
 * - set() 之后本页的声明式 sidebar 不再参与, 直到 drop() (即 app.sidebar.reset())
 *   清掉该页动态状态 —— 抑制表也一并清空, 于是又回到页面自己声明的那份菜单
 *
 * 渲染与切换:
 *
 * - 在侧栏里渲染项 (纯文字、左对齐、撑满侧栏宽度, 选中项高亮)
 * - 点击项切换选中态, 并把该项的 render 结果渲染进页面内容区。换的只是界面,
 *   地址栏不动 —— #/page 始终对应一级页面, 二级菜单不进路由
 * - 首个可点击项自动选中, 页面一打开就有内容
 * - 项的 render 结果落在页面容器 (.spa-page) 末尾一个独立子容器
 *   (.spa-sidebar-content) 里: 页面自己的 render() 先渲染骨架, 项内容接在
 *   它下面; 只写 sidebar 不写 render 时, 这个子容器就是页面的全部内容
 *
 * 没有菜单项时侧栏整块隐藏 (body.nav-collapsed), 内容区占满。
 *
 * 窄屏 (<= 768px): 侧栏成为内容区上方的折叠菜单, 由一个常驻的 header 条
 *   (点击切换展开/收起) 加一块高度可动画的内容区组成。展开高度在这里按像素算:
 *
 *     target = min(内容自然高度, #main 高度的 80% - header 条高度)
 *
 *   减掉 header 条高度, 因为"不超过 #main 的 80%"指的是整块菜单。内容装不下时
 *   由菜单自身滚动, 滚动条要等高度动画结束再放出, 否则动画途中它就会跟着高度
 *   一起冒出来; 这也是为什么 overflow 由这里的 .scrollable 类控制, 而不是写死
 *   在样式里。
 *
 *   被顶开的内容区不需要本模块做任何事: 窄屏下 #page-view 的高度锁定为
 *   "#main 高度 - header 条", 菜单长高多少它就被顶下去多少 (见 layout.css),
 *   于是两者天然同步, 不存在两份动画对不齐的问题。
 *
 * 高度是动画值, 只能用 JS 算: "内容自然高度"与"容器高度的 80%"里较小的那个,
 * CSS 拿不到。
 *
 * 注意: 这里的 animMs 必须与 layout.css 里 .spa-sidebar 的 height 过渡时长
 * (--dur-slow) 一致 —— 这是 JS 与 CSS 的隐式耦合, 改一处要同步另一处。
 */
import { attachTooltip } from "./components/tooltip.js";

/** 窄屏断点: 必须与 layout.css 的媒体查询一致 */
const NARROW_QUERY = "(max-width: 768px)";

/** 展开高度上限: 整块菜单 (header 条 + 内容) 不超过 #main 高度的这个比例 */
const HEIGHT_RATIO = 0.8;

/**
 * 规范化一个菜单项定义
 *
 * 统一成 `{ id, title, kind, render, def }`: 字符串是文本项 (分组标题),
 * 对象是可选中的菜单项。取不出 id/title 的定义直接丢弃 (调用方多半写错了,
 * 静默丢弃比抛异常更适合运行期动态注册的场景)。
 *
 * @param {string | object} def 菜单项定义
 * @returns {{ id: string, title: string, kind: "item" | "label", render?: Function, def: unknown } | null}
 */
function normalizeItem(def) {
	if (typeof def === "string") {
		return { id: `label:${def}`, title: def, kind: "label", def };
	}
	if (!def || typeof def !== "object") return null;

	const title = typeof def.title === "string" ? def.title : "";
	// id 缺省取 title: 页面重新声明 (每次 render 都新建对象) 时, 靠它认出"还是那一条"
	const id = typeof def.id === "string" && def.id.length > 0 ? def.id : title;
	if (!id) return null;

	return {
		id,
		title,
		kind: "item",
		render: typeof def.render === "function" ? def.render : undefined,
		def,
	};
}

/**
 * 规范化一组定义, 丢掉取不出 id 的
 * @param {unknown} defs
 * @returns {object[]}
 */
function normalizeAll(defs) {
	return (Array.isArray(defs) ? defs : []).map(normalizeItem).filter(Boolean);
}

/**
 * 从目标里找出它在列表中的下标
 *
 * 支持四种写法: 数字 = 下标; 字符串 = id, 找不到再按 title 找;
 * 对象 = 先按引用/来源定义比对, 再按它的 id/title 找。
 *
 * @param {object[]} items 已规范化的菜单项
 * @param {number | string | object} target
 * @returns {number} 找不到返回 -1
 */
function resolveIndex(items, target) {
	if (typeof target === "number") {
		return Number.isInteger(target) && target >= 0 && target < items.length ? target : -1;
	}
	if (typeof target === "string") {
		const byId = items.findIndex((i) => i.id === target);
		return byId >= 0 ? byId : items.findIndex((i) => i.title === target);
	}
	if (target && typeof target === "object") {
		const byRef = items.findIndex((i) => i === target || i.def === target);
		if (byRef >= 0) return byRef;
		const key = typeof target.id === "string" && target.id ? target.id : target.title;
		if (typeof key === "string" && key) {
			const byId = items.findIndex((i) => i.id === key);
			if (byId >= 0) return byId;
		}
	}
	return -1;
}

/**
 * 创建次级侧栏控制器
 *
 * @param {object} opts
 * @param {HTMLElement | null} [opts.container] 侧栏容器 #side-bar; 为 null 时只维护菜单表, 不碰 DOM
 * @param {HTMLElement} opts.main 内容区 #main (窄屏展开高度上限的基准)
 * @param {number} [opts.animMs=280] 高度动画时长(ms), 需与 CSS 的 --dur-slow 一致
 * @returns {{
 *   render: (page: object, view: HTMLElement, app?: object, pageId?: string) => Promise<void>,
 *   clear: () => void,
 *   drop: (pageId: string, opts?: { restore?: boolean }) => void,
 *   refresh: (pageId: string) => object[],
 *   list: (pageId: string) => object[],
 *   add: (pageId: string, def: string | object, index?: number) => object | null,
 *   remove: (pageId: string, target: number | string | object) => boolean,
 *   set: (pageId: string, defs: unknown) => object[],
 *   select: (pageId: string, target: number | string | object, opts?: { force?: boolean }) => Promise<object | null>,
 *   currentPageId: () => string | null,
 * }}
 */export function createSidebar({ container = null, main, animMs = 280 }) {
	// ---- 折叠开关条 (菜单 header): 窄屏才显示, 宽屏由 CSS 隐藏 ----
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "sidebar-toggle";
	toggle.setAttribute("aria-expanded", "false");
	attachTooltip(toggle, "展开 / 收起二级菜单");

	const caret = document.createElement("span");
	caret.className = "sidebar-toggle-caret";
	caret.setAttribute("aria-hidden", "true");

	const label = document.createElement("span");
	label.className = "sidebar-toggle-label";

	toggle.append(caret, label);

	const narrow = matchMedia(NARROW_QUERY);

	// ---- 菜单表: 页面 id -> 该页的二级菜单状态 ----
	/**
	 * @type {Map<string, {
	 *   declared: object[], dynamic: Array<{ item: object, index: number }>,
	 *   suppressed: Set<string>, overridden: boolean,
	 *   page: object | null, pendingActiveId: string | null,
	 * }>}
	 */
	const menus = new Map();

	/** 取(或建)某页的菜单状态; create=false 时只查不建 */
	function menuOf(pageId, create = true) {
		let menu = menus.get(pageId);
		if (!menu && create) {
			menu = {
				declared: [],
				dynamic: [],
				suppressed: new Set(),
				overridden: false,
				page: null,
				pendingActiveId: null,
			};
			menus.set(pageId, menu);
		}
		return menu ?? null;
	}

	/**
	 * 一个页面的最终菜单 = 声明项 + 动态项
	 *
	 * 动态项按登记顺序叠加: 同 id 覆盖原位置 (更新), 否则按登记时的 index 插入
	 * (index < 0 为追加)。被 remove 抑制掉的 id 一律跳过。
	 *
	 * @param {object | null} menu
	 * @returns {object[]}
	 */
	function effective(menu) {
		if (!menu) return [];

		const list = menu.overridden
			? []
			: menu.declared.filter((item) => !menu.suppressed.has(item.id));

		for (const entry of menu.dynamic) {
			const item = entry.item;
			if (menu.suppressed.has(item.id)) continue;

			const at = list.findIndex((i) => i.id === item.id);
			if (at >= 0) list[at] = item;
			else if (entry.index >= 0 && entry.index <= list.length) list.splice(entry.index, 0, item);
			else list.push(item);
		}
		return list;
	}

	// ---- 当前页面的 DOM ----
	/** 当前打开的页面 id; null 表示没有页面 */
	let currentId = null;
	/** 当前页面模块 (取标题 / 重新读声明) */
	let currentPage = null;
	/** 菜单项 render 的第二个参数 (SPA 应用对象), 由 framework 传入 */
	let app = null;
	/** @type {HTMLElement | null} 菜单项宿主 (每次换页重建) */
	let host = null;
	/** @type {HTMLElement | null} 项内容的宿主, 挂在页面容器末尾 */
	let content = null;
	/** @type {object[]} 当前渲染的菜单项 (effective 的快照) */
	let items = [];
	/** @type {HTMLElement[]} 与 items 一一对应的 DOM 节点 */
	let nodes = [];
	/** 当前选中项的 id; null 表示没有选中任何项 */
	let activeId = null;
	/** 当前已渲染内容的项 (用于判断同一条菜单要不要重渲) */
	let activeItem = null;
	/** 选中序号: 用于丢弃被后续点击取代的过期渲染 */
	let selectSeq = 0;

	/** 窄屏折叠菜单是否展开 */
	let expanded = false;
	/** 内容自然高度是否已超上限 (决定展开后要不要滚动) */
	let capped = false;
	let settleTimer = 0;
	let resizeTimer = 0;

	/** 展开高度上限: #main 高度的 80% 减去 header 条占的高度 */
	function heightLimit() {
		return Math.max(0, main.clientHeight * HEIGHT_RATIO - toggle.offsetHeight);
	}

	/**
	 * 内容的自然高度 (不受高度上限限制时的完整高度)
	 *
	 * 优先读 scrollHeight: 它只看内容、不改样式, 因而不会破坏 height 过渡。
	 * 若临时把 height 改成 auto 再读回来, 读布局会强制一次样式重算, 浏览器
	 * 就把 auto 记成了"上一次的值" —— 紧接着设的像素值与 auto 之间不可插值,
	 * 展开动画就没了 (收起方向不受影响, 因为它的起点是已经提交过的像素值)。
	 *
	 * 前提是菜单项不参与 flex 伸缩 (见 layout.css 的 .spa-sidebar-item): 若它们
	 * 会被容器压扁, 收起态 (height: 0) 下 scrollHeight 就会量出偏小的值。
	 */
	function naturalHeight() {
		if (!host) return 0;
		const scrolled = host.scrollHeight;
		if (scrolled > 0) return scrolled;

		// 兜底: 内容报不出高度时 (例如全是绝对定位子元素) 才退回临时改高度测量
		const prev = host.style.height;
		host.style.height = "auto";
		const measured = host.getBoundingClientRect().height;
		host.style.height = prev;
		return measured;
	}

	/** 高度动画结束后, 才按"内容是否装得下"决定滚动条的去留 */
	function settle() {
		clearTimeout(settleTimer);
		settleTimer = 0;
		if (!host) return;
		host.classList.toggle("scrollable", expanded && capped);
	}

	/** 兜底: 高度没有实际变化时 transitionend 不会触发, 别让滚动条状态卡住 */
	function armSettle() {
		clearTimeout(settleTimer);
		settleTimer = setTimeout(settle, animMs + 40);
	}

	/** 按当前状态重新量一次高度 (展开时用; 窗口尺寸变化后也要重来) */
	function applyHeight() {
		if (!host) return;
		const limit = heightLimit();
		const natural = naturalHeight();
		capped = natural > limit;

		// 动画途中先收起滚动条, 结束时由 settle() 按 capped 放出
		host.classList.remove("scrollable");
		host.style.height = `${Math.min(natural, limit)}px`;
		armSettle();
	}

	function open() {
		if (!host) return;
		expanded = true;
		toggle.setAttribute("aria-expanded", "true");
		applyHeight();
	}

	function collapse() {
		expanded = false;
		capped = false;
		toggle.setAttribute("aria-expanded", "false");
		if (!host) return;
		host.classList.remove("scrollable");
		host.style.height = "0px";
		armSettle();
	}

	/**
	 * 清掉本模块写入的行内状态, 让侧栏回到样式表定义的形态
	 *
	 * 两处需要: 换页 (新菜单一律收起), 以及跨断点 (宽屏没有折叠这回事,
	 * 窄屏则回到收起态)。
	 */
	function reset() {
		expanded = false;
		capped = false;
		clearTimeout(settleTimer);
		clearTimeout(resizeTimer);
		toggle.setAttribute("aria-expanded", "false");
		if (host) {
			host.classList.remove("scrollable");
			host.style.height = "";
		}
	}

	toggle.addEventListener("click", () => {
		if (!host || !narrow.matches) return; // 宽屏下按钮不显示, 这里只是兜底
		if (expanded) collapse();
		else open();
	});

	narrow.addEventListener("change", reset);

	// 窄屏下窗口尺寸变化 (含横竖屏旋转) 会改变上限与内容的换行结果, 需要重算
	window.addEventListener("resize", () => {
		if (!expanded || !narrow.matches) return;
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(applyHeight, 120);
	});

	/** 找一个菜单项在 items 里的位置 (kind 不是 item 的文本项不可选中) */
	function findSelectable(target) {
		const index = resolveIndex(items, target);
		return index >= 0 && items[index].kind === "item" ? items[index] : null;
	}

	/** 第一个可点击项的 id (全是文本项时返回 null) */
	function firstSelectableId() {
		const item = items.find((i) => i.kind === "item");
		return item ? item.id : null;
	}

	/** 清空项内容区 */
	function clearContent() {
		activeItem = null;
		content?.replaceChildren();
	}

	/** 按 activeId 同步按钮高亮 */
	function syncActive() {
		for (let i = 0; i < nodes.length; i++) {
			if (items[i]?.kind !== "item") continue;
			nodes[i].classList.toggle("active", items[i].id === activeId);
		}
	}

	/** 窄屏展开着的时候列表变了: 高度可能不够, 重算一次 */
	function reflow() {
		if (expanded && narrow.matches && host) applyHeight();
	}

	/**
	 * 选中一条菜单项
	 *
	 * 只改界面, 不动地址栏: 二级菜单不进路由, 刷新后回到页面的首个项
	 * (与 bot 详情弹窗里那套窗口内的侧栏导航是同一个模型)。
	 *
	 * 页面不是当前页时只记下"下次打开时选它" (pendingActiveId): 内容区那时
	 * 还不属于这个页面, 现在渲染没有意义。
	 *
	 * @param {string} pageId 页面 id
	 * @param {number | string | object} target 项 (id / 下标 / 定义对象)
	 * @param {{ force?: boolean }} [opts] force=true 时即使同一条也重渲内容
	 * @returns {Promise<object | null>} 被选中的项
	 */
	async function select(pageId, target, { force = false } = {}) {
		if (pageId !== currentId) {
			// 页面没开着: 记下"下次打开时选它", 那时内容区才属于这个页面
			const menu = menuOf(pageId);
			const menuItems = effective(menu);
			const index = resolveIndex(menuItems, target);
			const wanted = index >= 0 && menuItems[index].kind === "item" ? menuItems[index] : null;
			menu.pendingActiveId = wanted ? wanted.id : null;
			return null;
		}

		const item = findSelectable(target);
		if (!item) return null;

		// 同一条菜单且 render 没变: 只补高亮, 不重渲 (避免每次点击都重建内容)
		if (!force && activeItem && item.id === activeId && item.render === activeItem.render) {
			activeId = item.id;
			syncActive();
			return item;
		}

		activeId = item.id;
		activeItem = item;
		syncActive();

		if (!content) return item; // 没有内容宿主 (页面上没有容器): 只高亮

		const seq = ++selectSeq;
		content.replaceChildren();
		try {
			await item.render?.(content, app);
		} catch (err) {
			console.error(`[SPA] 渲染二级菜单项 "${item.title}" 失败:`, err);
			if (seq === selectSeq) {
				const tip = document.createElement("p");
				tip.className = "muted";
				tip.textContent = "该项内容渲染失败";
				content.replaceChildren(tip);
			}
			return item;
		}
		if (seq !== selectSeq) return item; // 已被后续点击取代

		collapse(); // 关闭二级菜单
		label.textContent = currentPage?.title
			? `${currentPage.title} / ${item.title}`
			: item.title;
		// 窄屏展开状态下换项: 内容高度可能变了, 重算一次, 否则新内容会被裁掉
		reflow();
		return item;
	}

	/**
	 * 列表变化后让选中态与内容跟上
	 *
	 * 三种情况: 选中项还在且没换 render -> 原样保留; 还在但换了 render
	 * (页面重新声明过) -> 重渲; 没了 -> 清空后就近另选一个。
	 */
	function ensureSelection() {
		if (!content) return;

		const kept = activeId != null ? findSelectable(activeId) : null;
		if (kept) {
			// 同一条菜单: render 没换就不动内容, 换了 (页面重新声明过) 才重渲
			if (activeItem && kept.render === activeItem.render) return;
			void select(currentId, kept.id, { force: true });
			return;
		}

		activeId = null;
		clearContent();
		const next = firstSelectableId();
		if (next != null) void select(currentId, next);
	}

	/** 创建一个菜单项按钮 */
	function createItemButton(item) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "spa-sidebar-item";
		btn.textContent = item.title;
		btn.addEventListener("click", () => { void select(currentId, item.id); });
		return btn;
	}

	/** 创建一个文本项 (分组标题), 不可点击不参与选中 */
	function createLabel(item) {
		const h = document.createElement("h4");
		h.className = "spa-sidebar-label";
		h.textContent = item.title;
		return h;
	}

	/**
	 * 把当前页面的菜单渲染到侧栏 (列表变化后也走这里)
	 *
	 * 按钮整批重建: 菜单规模是"十几个"级别, 重建比做差异更新简单得多, 也不
	 * 会漏掉任何一处状态。选中态与内容由 ensureSelection() 按 id 续上。
	 */
	function paint() {
		items = currentId == null ? [] : effective(menuOf(currentId));

		// 没有侧栏容器、或本页没有菜单项: 整块让位 (内容区占满)
		document.body.classList.toggle("nav-collapsed", !container || items.length === 0);
		if (!container || !host) {
			activeId = null;
			activeItem = null;
			return;
		}

		nodes = items.map((item) =>
			item.kind === "label" ? createLabel(item) : createItemButton(item)
		);
		host.replaceChildren(...nodes);

		ensureSelection();
		syncActive();
		reflow();
	}

	/** 页面是当前页时才刷新界面 (别的页面只改菜单表) */
	function refreshIfCurrent(pageId) {
		if (pageId === currentId) paint();
	}

	/**
	 * 渲染一个页面的二级菜单 (页面打开时调用)
	 *
	 * @param {object} page 页面模块
	 * @param {HTMLElement} view 页面容器 (.spa-page), 项内容的落点在其末尾
	 * @param {object} [api] SPA 应用对象, 转交给菜单项的 render(container, app)
	 * @param {string} [pageId] 页面在框架里的注册 id (页面模块未必声明 id, 所以要显式给)
	 */
	async function render(page, view, api, pageId) {
		if (api) app = api;
		currentId = typeof pageId === "string" && pageId
			? pageId
			: (typeof page?.id === "string" && page.id ? page.id : null);
		currentPage = page ?? null;
		selectSeq++;
		activeId = null;
		activeItem = null;
		items = [];
		nodes = [];
		content = null;

		if (!container) {
			// 页面上没有 #side-bar 元素: 保持无侧栏的布局
			document.body.classList.add("nav-collapsed");
			return;
		}

		const menu = menuOf(currentId);
		menu.page = currentPage;
		// 声明式菜单: 每次打开都重新读一遍 (页面可能在自己的 render() 里改写它);
		// 被 set() 接管过的页面不再读声明, 直到 drop()
		if (!menu.overridden) menu.declared = normalizeAll(page?.sidebar);

		const next = document.createElement("div");
		next.className = "spa-sidebar";
		next.addEventListener("transitionend", (e) => {
			if (e.propertyName === "height") settle();
		});

		host = next;
		// 换页即换菜单: 新宿主连同 header 条一起换上, 折叠状态回到收起
		container.replaceChildren(toggle, next);
		reset();

		// 内容宿主总是建出来 (即使当前没有菜单项): 运行期新增的项才有地方渲染
		if (view) {
			const body = document.createElement("div");
			body.className = "spa-sidebar-content";
			content = body;
			view.appendChild(body);
		}

		// 上次在这页留下过"想选中哪一项" (见 select): 优先用它
		activeId = menu.pendingActiveId ?? null;
		menu.pendingActiveId = null;

		paint();
	}

	/**
	 * 清掉侧栏 (一个页面都没有时由 framework 调用)
	 *
	 * 连同折叠 header 一起撤掉, 回到"没有二级菜单"的初始形态。
	 */
	function clear() {
		currentId = null;
		currentPage = null;
		selectSeq++;
		clearTimeout(settleTimer);
		clearTimeout(resizeTimer);
		items = [];
		nodes = [];
		activeId = null;
		activeItem = null;
		content = null;
		host = null;
		container?.replaceChildren();
		document.body.classList.add("nav-collapsed");
	}

	/**
	 * 丢掉某页的全部动态状态
	 *
	 * 页面正开着且 restore 为真时, 立即把声明式菜单读回来 (reset 的语义: 回到
	 * 页面自己声明的菜单); 页面马上要被注销/换掉时传 restore=false —— 那一页
	 * 的菜单表不该再重建, 接下来由新页面的 render 接管界面。
	 *
	 * @param {string} pageId
	 * @param {{ restore?: boolean }} [opts]
	 */
	function drop(pageId, { restore = true } = {}) {
		menus.delete(pageId);
		if (!restore || pageId !== currentId) return;

		const menu = menuOf(pageId);
		menu.page = currentPage;
		menu.declared = normalizeAll(currentPage?.sidebar);
		paint();
	}

	/**
	 * 重新读取页面模块的 sidebar 声明并刷新界面
	 *
	 * 页面在自己的 render() 之后又改了 `page.sidebar` 时用它; 平时不需要 ——
	 * framework 是在页面 render() 之后才读声明、渲染侧栏的。
	 *
	 * @param {string} pageId
	 * @returns {object[]} 该页最新的菜单
	 */
	function refresh(pageId) {
		const menu = menuOf(pageId);
		if (!menu.overridden) menu.declared = normalizeAll(menu.page?.sidebar);

		if (pageId === currentId && !menu.overridden) {
			// 声明整批换了对象: 让 ensureSelection 认出"同 id 换了 render"并重渲
			paint();
		}
		return effective(menu);
	}

	/**
	 * 查一个页面当前的二级菜单 (声明 + 动态, 已去掉被删的)
	 * @param {string} pageId
	 */
	function list(pageId) {
		return effective(menuOf(pageId, false)).map((item) => ({
			id: item.id,
			title: item.title,
			kind: item.kind,
			render: item.render,
		}));
	}

	/**
	 * 运行期新增 (或更新) 一条二级菜单
	 *
	 * @param {string} pageId 归属页面
	 * @param {string | object} def 菜单项定义
	 * @param {number} [index=-1] 插入位置 (相对最终列表); < 0 为追加
	 * @returns {object | null} 规范化后的项 (可直接交给 remove / select)
	 */
	function add(pageId, def, index = -1) {
		const item = normalizeItem(def);
		if (!item) return null;

		const menu = menuOf(pageId);
		// 显式重新添加 = 撤销之前的删除
		menu.suppressed.delete(item.id);

		const at = menu.dynamic.findIndex((e) => e.item.id === item.id);
		if (at >= 0) menu.dynamic[at] = { item, index };
		else menu.dynamic.push({ item, index });

		refreshIfCurrent(pageId);
		return item;
	}

	/**
	 * 运行期删除一条二级菜单
	 *
	 * 记在抑制表里, 因此页面重新声明 sidebar 时它不会复活。
	 *
	 * @param {string} pageId 归属页面
	 * @param {number | string | object} target 项 (id / 下标 / 定义对象)
	 * @returns {boolean} 是否删掉了什么
	 */
	function remove(pageId, target) {
		const menu = menuOf(pageId);
		const current = effective(menu);
		const index = resolveIndex(current, target);
		if (index < 0) return false;

		const id = current[index].id;
		menu.suppressed.add(id);

		const at = menu.dynamic.findIndex((e) => e.item.id === id);
		if (at >= 0) menu.dynamic.splice(at, 1);

		refreshIfCurrent(pageId);
		return true;
	}

	/**
	 * 整表替换一个页面的二级菜单 (声明式 sidebar 让位, 直到 drop)
	 *
	 * @param {string} pageId 归属页面
	 * @param {unknown} defs 菜单项定义数组
	 * @returns {object[]} 替换后的菜单
	 */
	function set(pageId, defs) {
		const menu = menuOf(pageId);
		menu.overridden = true;
		menu.declared = [];
		menu.suppressed.clear();
		menu.dynamic = normalizeAll(defs).map((item) => ({ item, index: -1 }));

		refreshIfCurrent(pageId);
		return effective(menu);
	}

	return {
		render,
		clear,
		drop,
		refresh,
		list,
		add,
		remove,
		set,
		select,
		currentPageId: () => currentId,
	};
}
