/**
 * 次级侧栏 (#side-bar) — 二级菜单
 *
 * 页面通过 sidebar 字段声明菜单项, 渲染与切换都交给框架:
 *
 * ```js
 * sidebar: [
 *   { title: "通用", render(container) { ... } },
 *   { title: "外观", render(container) { ... } },
 * ]
 * ```
 *
 * 框架负责这些行为:
 *
 * - 在侧栏里渲染项 (纯文字、左对齐、撑满侧栏宽度, 选中项高亮)
 * - 点击项切换选中态, 并把该项的 render 结果渲染进页面内容区。换的只是界面,
 *   地址栏不动 —— #/page 始终对应一级页面, 二级菜单不进路由
 * - 首个项自动选中, 页面一打开就有内容
 * - 项的内容渲染在页面容器 (.spa-page) 末尾一个独立子容器里: 页面自己的
 *   render() 先渲染骨架, 项内容接在它下面; 只写 sidebar 不写 render 时,
 *   这个子容器就是页面的全部内容
 *
 * 未提供 sidebar、或数组为空时, 侧栏整块隐藏 (body.nav-collapsed), 内容区占满。
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
 * 创建次级侧栏控制器
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container 侧栏容器 #side-bar
 * @param {HTMLElement} opts.main 内容区 #main (高度上限的基准)
 * @param {number} [opts.animMs=280] 高度动画时长(ms), 需与 CSS 的 --dur-slow 一致
 * @returns {{ render: (page: object, view: HTMLElement) => Promise<void> }}
 */
export function createSidebar({ container, main, animMs = 280 }) {
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

	// ---- 当前页面的二级菜单 ----
	/** @type {HTMLElement | null} 菜单项宿主 (每次换页重建) */
	let host = null;
	/** @type {HTMLElement | null} 项内容的宿主, 挂在页面容器末尾 */
	let content = null;
	/** @type {HTMLButtonElement[]} 当前页面的菜单项按钮 */
	let buttons = [];
	/** @type {Array<{ title: string, render?: Function }>} 当前页面的项定义 */
	let currentItems = [];
	/** 当前选中的项; -1 表示还没有选中任何项 */
	let activeIndex = -1;
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
		host.classList.toggle("scrollable", expanded && capped);
	}

	/** 兜底: 高度没有实际变化时 transitionend 不会触发, 别让滚动条状态卡住 */
	function armSettle() {
		clearTimeout(settleTimer);
		settleTimer = setTimeout(settle, animMs + 40);
	}

	/** 按当前状态重新量一次高度 (展开时用; 窗口尺寸变化后也要重来) */
	function applyHeight() {
		const limit = heightLimit();
		const natural = naturalHeight();
		capped = natural > limit;

		// 动画途中先收起滚动条, 结束时由 settle() 按 capped 放出
		host.classList.remove("scrollable");
		host.style.height = `${Math.min(natural, limit)}px`;
		armSettle();
	}

	function open() {
		expanded = true;
		toggle.setAttribute("aria-expanded", "true");
		applyHeight();
	}

	function collapse() {
		expanded = false;
		capped = false;
		toggle.setAttribute("aria-expanded", "false");
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

	/**
	 * 选中一个菜单项
	 *
	 * 只改界面, 不动地址栏: 二级菜单不进路由, 刷新后回到页面的首个项
	 * (与 bot 详情弹窗里那套窗口内的侧栏导航是同一个模型)。
	 *
	 * @param {number} index 项下标
	 */
	async function select(index) {
		const item = currentItems[index];
		const target = content;
		if (!item || !target || index === activeIndex) return;

		activeIndex = index;
		for (let i = 0; i < buttons.length; i++) {
			buttons[i].classList.toggle("active", i === index);
		}

		const seq = ++selectSeq;
		target.replaceChildren();
		try {
			await item.render?.(target);
		} catch (err) {
			console.error(`[SPA] 渲染二级菜单项 "${item.title}" 失败:`, err);
			const tip = document.createElement("p");
			tip.className = "muted";
			tip.textContent = "该项内容渲染失败";
			if (seq === selectSeq) target.replaceChildren(tip);
			return;
		}
		if (seq !== selectSeq) return; // 已被后续点击取代

		// 窄屏展开状态下换项: 内容高度可能变了, 重算一次, 否则新内容会被裁掉
		if (expanded && narrow.matches) applyHeight();
	}

	/** 创建一个菜单项按钮 */
	function createItemButton(item, index) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "spa-sidebar-item";
		btn.textContent = item.title ?? "";
		btn.addEventListener("click", () => { void select(index); });
		return btn;
	}

	/**
	 * 渲染一个页面的二级菜单
	 *
	 * 只有页面提供了非空的 sidebar 数组, 侧栏才显示; 否则整块隐藏。
	 * 项内容渲染进追加在页面容器末尾的独立子容器, 与页面骨架互不干扰。
	 *
	 * @param {object} page 页面模块
	 * @param {HTMLElement} view 页面容器 (.spa-page), 项内容的落点在其末尾
	 */
	async function render(page, view) {
		const items = Array.isArray(page.sidebar) ? page.sidebar.filter(Boolean) : [];

		const next = document.createElement("div");
		next.className = "spa-sidebar";
		next.addEventListener("transitionend", (e) => {
			if (e.propertyName === "height") settle();
		});

		host = next;
		content = null;
		buttons = [];
		currentItems = items;
		activeIndex = -1;
		selectSeq++;
		label.textContent = page.title ?? "";

		// 换页即换菜单: 新宿主连同 header 条一起换上, 折叠状态回到收起
		container.replaceChildren(toggle, next);
		reset();

		document.body.classList.toggle("nav-collapsed", items.length === 0);
		if (items.length === 0) return;

		buttons = items.map(createItemButton);
		next.replaceChildren(...buttons);

		if (!view) return; // 没有页面容器: 只渲染菜单, 没处放内容

		const body = document.createElement("div");
		body.className = "spa-sidebar-content";
		content = body;
		view.appendChild(body);

		await select(0); // 首个项自动选中
	}

	return { render };
}
