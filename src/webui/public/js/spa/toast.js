/**
 * Toast 轻提示组件
 *
 * 在视口右上角弹出提示, 从上到下堆叠, 任意一条移除后其余自动向上补位。
 * 四种类型: info / debug / warn / error, 通过左侧彩色竖条区分。
 * 动画: 从右侧滑入, 消失时向右侧滑出 (见 toast.css 的 transform 过渡);
 * 每条 toast 右上角带一个小关闭按钮, 点击立即滑出。
 *
 * 用法:
 *   import toast, { TOAST_TYPES } from "./toast.js";
 *   toast("保存成功");
 *   toast("下载失败", { type: "error", duration: 5000 });
 *   toast("常驻提示", { duration: 0 }); // duration <= 0 表示不自动关闭
 */

/** 容器元素: 首次使用时懒创建, 挂在 body 下 */
let container = null;

/** 默认自动关闭时长 (ms), 可通过 options.duration 覆盖 */
const DEFAULT_DURATION = 3000;

/** 滑出动画时长 (ms), 与 toast.css 的 transition 时长保持一致 */
const EXIT_MS = 300;

/** 支持的提示类型 */
export const TOAST_TYPES = ["info", "debug", "warn", "error"];

/**
 * 弹出一条 toast
 *
 * @param {string} message 提示内容
 * @param {object} [options]
 * @param {"info"|"debug"|"warn"|"error"} [options.type="info"] 提示类型
 * @param {number} [options.duration=3000] 自动关闭时长(ms), <=0 表示不自动关闭
 * @returns {{ element: HTMLElement, close: () => void }} 元素与手动关闭函数
 */
export default function toast(message, options = {}) {
	const type = TOAST_TYPES.includes(options.type) ? options.type : "info";
	const duration = Number.isFinite(options.duration) ? options.duration : DEFAULT_DURATION;

	// 结构: [类型色条] 消息文字 [右上角关闭按钮]
	const el = document.createElement("div");
	el.className = `toast toast-${type}`;
	el.setAttribute("role", "status");

	const msg = document.createElement("p");
	msg.className = "toast-msg";
	msg.textContent = String(message);
	el.appendChild(msg);

	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.className = "toast-close";
	closeBtn.setAttribute("aria-label", "关闭提示");
	closeBtn.textContent = "×";
	el.appendChild(closeBtn);

	// 追加后立即强制回流, 让浏览器记录滑入前的位置, 再加 show 类触发过渡
	getContainer().appendChild(el);
	void el.offsetWidth;
	el.classList.add("toast-show");

	// 统一出口: 滑出后移除; closed 标志防止重复触发
	let timer = 0;
	let closed = false;
	const dismiss = () => {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		el.classList.remove("toast-show");
		el.classList.add("toast-hiding");
		setTimeout(() => el.remove(), EXIT_MS);
	};

	closeBtn.addEventListener("click", dismiss);
	if (duration > 0) timer = setTimeout(dismiss, duration);

	return { element: el, close: dismiss };
}

/** 获取全局容器, 不存在时创建并挂到 body */
function getContainer() {
	if (!container) {
		container = document.createElement("div");
		container.id = "toast-container";
		container.setAttribute("aria-live", "polite");
		document.body.appendChild(container);
	}
	return container;
}
