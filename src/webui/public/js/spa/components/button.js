/**
 * 
 * @param {string} text 按钮显示内容
 * @param {(event: MouseEvent) => (void | Promise<void>)} onclick 点击回调
 */
export function createButton(text, onclick) {
	const btn = document.createElement("button");
	btn.innerHTML = text;

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

	btn.classList.add("btn")

	return btn;
}