/**
 * 悬停提示浮窗 — VS Code 风格的 tooltip
 *
 * 用来替代原生 title 属性。原生提示在导航按钮上尤其难用: 位置由浏览器
 * 决定 (压在按钮身上或按钮下方), 延迟与外观也都不可调。这里自绘一个浮窗:
 *
 * - 悬停 500ms 后出现在锚点右侧并垂直居中 (与 VS Code 的活动栏提示一致),
 *   期间移开鼠标则不显示
 * - 右侧空间不足时翻到锚点左侧, 再被视口边缘夹住, 不作为地溢出屏幕
 * - 键盘 Tab 聚焦立即显示, 键盘用户不必经历悬停延迟
 * - 鼠标移出 / 失焦 / 滚动 / 缩放 / 点击 / 切页时一律隐藏
 *
 * 浮窗挂在 document.body 上并用 position: fixed 定位 —— 锚点常处在带
 * overflow: hidden 的容器里 (如活动栏), 挂在锚点内部的浮层会被裁掉。
 *
 * 用法:
 *
 * ```js
 * import { attachTooltip } from "./components/tooltip.js";
 * attachTooltip(btn, "首页");            // 固定文本
 * attachTooltip(btn, () => labelOf());   // 或每次显示时求值
 * ```
 *
 * 无障碍: 浮窗是纯视觉补充 (标了 aria-hidden), 锚点的可访问名要另行提供
 * (aria-label 或可见文本), 否则屏幕阅读器读不到这份提示。
 */

/** 悬停多久后显示 (ms), 与 VS Code 的提示延迟一致 */
const SHOW_DELAY_MS = 500;

/** 浮窗与锚点之间的水平间距 (px) */
const GAP = 6;

/** 浮窗与视口边缘的最小留白 (px) */
const VIEWPORT_MARGIN = 8;

/** 各锚点的文本来源 (字符串或取值函数), 由 attachTooltip 写入 */
const sources = new WeakMap();

/** 共享浮窗元素: 全站只有一个, 首次显示时创建 */
let host = null;

/** 当前正在显示的锚点 */
let anchor = null;

/** 挂起的显示定时器 id, 0 表示没有挂起 */
let showTimer = 0;

/** 懒创建共享浮窗元素 */
function ensureHost() {
	if (host) return host;

	host = document.createElement("div");
	host.className = "spa-tooltip";
	// 纯视觉提示: 可访问名由锚点自身的 aria-label 提供, 这里不再重复朗读
	host.setAttribute("aria-hidden", "true");
	document.body.appendChild(host);
	return host;
}

/** 取锚点的提示文本; 返回空串表示这个锚点当前不该显示提示 */
function textOf(target) {
	const source = sources.get(target);
	const text = typeof source === "function" ? source(target) : source;
	return text == null ? "" : String(text).trim();
}

/**
 * 把浮窗摆到锚点右侧
 *
 * 尺寸在浮窗不可见时读取: visibility: hidden 的元素仍参与布局,
 * 所以可以先定好位再显示, 不会出现"先冒出来再挪位"的闪动。
 *
 * @param {HTMLElement} target 锚点元素
 */
function place(target) {
	const el = ensureHost();
	const rect = target.getBoundingClientRect();
	const w = el.offsetWidth;
	const h = el.offsetHeight;

	// 首选: 锚点右侧, 与锚点垂直居中对齐
	let left = rect.right + GAP;
	if (left + w > window.innerWidth - VIEWPORT_MARGIN) {
		// 右边放不下就翻到左侧
		left = rect.left - GAP - w;
	}
	let top = rect.top + (rect.height - h) / 2;

	// 兜底: 窗口太窄或太矮时 (左右都放不下) 夹进视口, 宁可贴边也不溢出
	left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - VIEWPORT_MARGIN - w));
	top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - VIEWPORT_MARGIN - h));

	// 定位只用 transform (CSS 里 left/top 固定为 0): 每次显示不触发重排
	el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/** 立即显示锚点的浮窗 */
function show(target) {
	const text = textOf(target);
	if (!text) return;

	const el = ensureHost();
	el.textContent = text;
	anchor = target;
	place(target); // 换了文本就可能换了尺寸, 定位要在写入文本之后
	el.classList.add("spa-tooltip-visible");
}

/** 隐藏浮窗, 并取消挂起的显示 */
function hide() {
	clearTimeout(showTimer);
	showTimer = 0;
	anchor = null;
	host?.classList.remove("spa-tooltip-visible");
}

/** 悬停后延迟显示 */
function scheduleShow(target) {
	clearTimeout(showTimer);
	showTimer = setTimeout(() => show(target), SHOW_DELAY_MS);
}

function onPointerEnter(e) {
	// 触摸屏上 pointerenter 由点击合成: 此时弹提示没人看, 还会留在屏幕上
	if (e.pointerType === "touch") return;
	scheduleShow(e.currentTarget);
}

function onFocus(e) {
	// 鼠标点击也会聚焦按钮, 那种情况不该立刻弹提示 (点击是要跳页);
	// :focus-visible 只对键盘操作成立, 用它把键盘用户择出来
	if (!e.currentTarget.matches?.(":focus-visible")) return;
	clearTimeout(showTimer);
	showTimer = 0;
	show(e.currentTarget);
}

/**
 * 给元素挂上悬停提示
 *
 * @param {HTMLElement} target 锚点元素
 * @param {string | ((target: HTMLElement) => string)} text 提示文本, 或每次显示时求值的函数
 * @returns {() => void} 解绑函数
 */
export function attachTooltip(target, text) {
	if (!target) return () => { };

	sources.set(target, text);
	target.addEventListener("pointerenter", onPointerEnter);
	target.addEventListener("pointerleave", hide);
	target.addEventListener("focus", onFocus);
	target.addEventListener("blur", hide);

	return () => {
		sources.delete(target);
		target.removeEventListener("pointerenter", onPointerEnter);
		target.removeEventListener("pointerleave", hide);
		target.removeEventListener("focus", onFocus);
		target.removeEventListener("blur", hide);
		if (anchor === target) hide();
	};
}

// ---- 全局失效条件 ----
//
// 浮窗的位置是显示那一刻算出来的, 下面这些动作会让它对不上锚点,
// 或者已经失去意义, 一律隐藏。监听只注册一次 (本模块是单例组件)。

// 滚动: 锚点跟着动了 (capture 才能收到内部滚动容器的滚动)
window.addEventListener("scroll", hide, { capture: true, passive: true });
// 缩放: 视口变了, 之前算的坐标作废
window.addEventListener("resize", hide);
// 按下鼠标: 用户已经做出选择, 提示让路 (活动栏按钮点击即切页)
window.addEventListener("pointerdown", hide, { capture: true, passive: true });
// 切页: 导航可能重建, 旧锚点不再对应任何东西
window.addEventListener("hashchange", hide);
// 切走标签页: 回来时鼠标多半已不在原位
document.addEventListener("visibilitychange", hide);
