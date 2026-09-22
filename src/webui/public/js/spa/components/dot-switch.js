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

		const target = !state; // 目标状态: 由当前状态取反, 交给回调
		try {
			swh.classList.add("loading");
			swh.disabled = true;

			const newState = await onclick(e, target); // 触发回调

			// 以回调返回值为准: 失败回弹时内部状态跟着回退, 否则下一次点击
			// 会发出与用户所见相反的意图
			state = Boolean(newState);
			switchState(swh, state);
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