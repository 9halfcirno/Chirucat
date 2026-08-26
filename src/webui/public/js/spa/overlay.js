/**
 * SPA 加载遮罩组件
 *
 * 遮罩会被追加到 container 内, 并铺满整个 container
 * (container 需要有 position: relative 定位)。
 * 页面切换期间由框架调用 show() 盖住内容区, 加载完成后调用 hide()。
 *
 * 带淡入淡出动画: show() 从透明渐变为完全不透明, 返回的 Promise 在
 * 动画完成后 resolve; hide() 渐变为透明后隐藏, 返回的 Promise 在完全
 * 隐藏后 resolve。框架据此实现"淡入完成后再切换页面, 加载完再淡出"。
 *
 * 提供最小显示时长, 避免加载太快时遮罩一闪而过造成闪烁。
 */

/**
 * 创建加载遮罩
 *
 * @param {HTMLElement} container 遮罩的宿主元素 (通常是 #main)
 * @param {object} [options]
 * @param {number} [options.minShowTime=250] 遮罩每次显示的最小时长(ms)
 * @param {number} [options.fadeMs=200] 淡入/淡出动画时长(ms), 需与 CSS 中的 transition 时长一致
 * @returns {{ element: HTMLElement, show: () => Promise<void>, hide: () => Promise<void> }}
 */
export function createOverlay(container, options = {}) {
	const minShowTime = options.minShowTime ?? 250;
	const fadeMs = options.fadeMs ?? 200;

	const el = document.createElement("div");
	el.className = "spa-overlay";
	el.hidden = true;
	el.setAttribute("aria-hidden", "true");
	el.innerHTML = '<div class="spa-overlay-spinner" role="status" aria-label="加载中"></div>';
	container.appendChild(el);

	// show 计数: 连续多次 show 时, 过期的 hide 会被丢弃
	let showCount = 0;
	let shownAt = 0;

	/**
	 * 淡入并显示遮罩
	 *
	 * 先移除 visible 类并强制回流, 确保 transition 以 opacity 0 为起点,
	 * 再加回 visible 类触发 0 -> 1 的过渡。resolve 时淡入已完成, 遮罩
	 * 已完全不透明, 调用方可以放心切换页面。
	 *
	 * @returns {Promise<void>}
	 */
	function show() {
		showCount++;
		shownAt = Date.now();
		el.hidden = false;
		el.classList.remove("spa-overlay-visible");
		void el.offsetWidth; // 强制回流, 让浏览器记录 opacity 0 的起点
		el.classList.add("spa-overlay-visible");
		return new Promise((resolve) => setTimeout(resolve, fadeMs));
	}

	/**
	 * 淡出并隐藏遮罩
	 *
	 * 先等待最小显示时长 (避免加载太快时一闪而过), 再移除 visible 类
	 * 触发 1 -> 0 的过渡, 动画结束后真正隐藏。期间若又有新的 show,
	 * 本次 hide 作废 (resolve 但保持遮罩可见)。resolve 时遮罩已完全隐藏。
	 *
	 * @returns {Promise<void>}
	 */
	function hide() {
		const count = showCount;
		const wait = Math.max(0, minShowTime - (Date.now() - shownAt));
		return new Promise((resolve) => {
			setTimeout(() => {
				// 等待期间又有新的 show, 说明进入了新一轮加载, 本次 hide 作废
				if (showCount !== count) {
					resolve();
					return;
				}
				el.classList.remove("spa-overlay-visible");
				setTimeout(() => {
					// 淡出期间又被 show, 本次隐藏作废
					if (showCount === count) el.hidden = true;
					resolve();
				}, fadeMs);
			}, wait);
		});
	}

	return { element: el, show, hide };
}
