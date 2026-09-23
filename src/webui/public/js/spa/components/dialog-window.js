import { createButton } from "./button.js";
import { createIconButton } from "./icon-button.js";

/**
 * 
 * @param {string} title 
 * @param {string | HTMLElement} inner 
 * @param {{ name: string, onclick: (event: PointerEvent) => void, danger?: boolean }[]} btns 
 * @param {{ cancelable?: boolean, maximize?: boolean }} [option] 设置窗口属性
 */
export function createDialogWindow(title, inner, btns, option = {}) {
	const base = document.createElement("div");
	base.classList.add("dialog-window-base");

	const win = document.createElement("div");
	win.classList.add("dialog-window");
	base.append(win);

	const header = document.createElement("header");
	win.append(header);

	const titleSpan = document.createElement("span");
	titleSpan.classList.add("dialog-window-title");
	titleSpan.innerHTML = title || "Dialog";
	header.append(titleSpan);


	// 窗口尺寸
	if (option.maximize) { // 默认是正常
		let maxBtn = createIconButton("/img/icons/maximize.svg", () => {
			win.classList.add("maximize");
			maxBtn.style.display = "none";
			resBtn.style.removeProperty("display");
		})
		let resBtn = createIconButton("/img/icons/restore.svg", () => {
			win.classList.remove("maximize");
			resBtn.style.display = "none";
			maxBtn.style.removeProperty("display");
		})
		resBtn.style.display = "none";
		header.append(maxBtn, resBtn)
	}

	if (option.cancelable) {
		// 统一的关闭出口: 移除键盘监听后再删除节点, 避免多次打开时监听器泄漏
		const onKeydown = (e) => {
			if (e.key === "Escape") close();
		};
		const close = () => {
			document.removeEventListener("keydown", onKeydown);
			base.remove();
		};

		// Esc 关闭 (仅 cancelable 对话框; 生命周期随对话框, 不会串到下一个对话框)
		document.addEventListener("keydown", onKeydown);

		let clsBtn = createIconButton("/img/icons/cancel.svg", () => {
			close();
		})
		header.append(clsBtn);

		// 暴露给外部编程式关闭 (如创建成功后关闭): 需走 close 以清理 Esc 监听器,
		// 直接 base.remove() 会留下监听器泄漏
		base.closeDialog = close;
	}

	if (inner) {
		let innerDiv = document.createElement("div");
		innerDiv.classList.add("dialog-window-inner")
		if (typeof inner === "string") {
			innerDiv.innerHTML = inner;
		} else {
			innerDiv.append(inner);
		}
		win.append(innerDiv);
	}

	let footer = document.createElement("footer");
	if (btns.length > 0) {
		let btnBar = document.createElement("div");
		btnBar.classList.add("dialog-window-btns");
		footer.append(btnBar);

		for (let btn of btns) {
			let btnEle = createButton(btn.name || "", btn.onclick || null);
			if (btn.danger) {
				btnEle.classList.add("danger");
			}
			btnBar.append(btnEle);
		}
	}

	if (footer.childElementCount > 0) {
		win.append(footer);
	}

	return base;
}