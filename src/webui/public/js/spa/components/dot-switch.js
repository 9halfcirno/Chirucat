/**
 * 
 * @param {(e: PointerEvent, state: boolean) => (Promise<boolean> | boolean)} onclick 开关被点击后的回调, 传入的状态为目标状态, 返回值确定开关状态
 * @param {boolean} state 定义开关的默认状态, 无指定则为true(启用)
 */
export function createDotSwitch(onclick, state = true) {
	const swh = document.createElement("button");

	swh.classList.add("dot-switch");


	let locked = false; // 点击锁, 避免异步处理时再次被点击
	swh.onclick = async (e) => {
		if (locked) return;
		locked = true; // 加锁

		state = !state; // 取反
		try {
			swh.classList.add("loading");
			swh.disabled = true;

			let newState = await onclick(e, state); // 触发回调

			switchState(swh, newState);
		} catch (e) {
			throw e; // 再抛
		} finally {
			swh.classList.remove("loading");
			swh.disabled = false;
			locked = false; // 解锁
		}
	}

	switchState(swh, state);

	return swh;
}

/**
 * 
 * @param {HTMLButtonElement} swh 
 * @param {boolean} state 
 */
function switchState(swh, state) {
	if (state) { // 状态为开
		swh.classList.remove("dot-switch-off");
		swh.classList.add("dot-switch-on");
	} else {
		swh.classList.remove("dot-switch-on");
		swh.classList.add("dot-switch-off");
	}
}