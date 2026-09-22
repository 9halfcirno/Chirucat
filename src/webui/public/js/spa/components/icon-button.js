/**
 * 创建图标按钮
 *
 * 图标用 mask + currentColor 渲染 (见 base.css 的 .icon), 因此跟随主题与
 * 悬停态变色 —— 这也是深色主题可用的前提: 图标 SVG 内写死了 stroke="#000",
 * 用 <img> 加载时 CSS 无法改色, 深色下会不可见。
 *
 * @param {string} src 图标 URL (SVG)
 * @param {(event: MouseEvent) => (void | Promise<void>)} [onclick] 点击回调
 */
export function createIconButton(src, onclick = null) {
	const btn = document.createElement("button");

	// src 为空时不创建图标元素: .icon 在没有 --icon 时会退化成一个
	// currentColor 实心色块 (mask 声明整条失效), 不如不渲染
	if (src) {
		const icon = document.createElement("span");
		icon.className = "icon";
		icon.style.setProperty("--icon", `url("${src}")`);
		btn.append(icon);
	}

	let locked = false; // 点击锁, 避免异步处理时再次被点击
	btn.onclick = async (e) => {
		if (locked) return;
		locked = true; // 加锁

		try {
			btn.disabled = true;

			onclick && await onclick(e); // 触发回调
		} catch (e) {
			throw e; // 再抛
		} finally {
			btn.disabled = false;
			locked = false; // 解锁
		}
	}

	btn.classList.add("icon-btn")

	return btn;
}