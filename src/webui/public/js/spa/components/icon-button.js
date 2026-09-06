/**
 * 
 * @param {string} src 图标URL
 * @param {number} size 图标尺寸
 * @param {(event: MouseEvent) => (void | Promise<void>)} onclick 点击回调
 */
export function createIconButton(src, onclick) {
	const btn = document.createElement("button");
	const image = document.createElement("img");
	image.src = src; // 设定图片url
	btn.append(image);

	let locked = false; // 点击锁, 避免异步处理时再次被点击
	btn.onclick = async (e) => {
		if (locked) return;
		locked = true; // 加锁

		try {
			btn.disabled = true;

			await onclick(e); // 触发回调
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