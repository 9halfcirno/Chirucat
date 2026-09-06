import { createIconButton } from "./icon-button.js";

/**
 * 
 * @param {string} title 
 * @param {string | HTMLElement} inner 
 * @param {{ name: string, onclick: (event: PointerEvent) => void}[]} btns 
 * @param {boolean} cancelable 
 */
export function createDialogWindow(title, inner, btns, cancelable) {
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

	if (cancelable) {
		base.onclick = (e) => {
			if (e.target === base) {
				base.remove();
			}
		}
		let clsBtn = createIconButton("/img/icons/cancel.svg", () => {
			base.remove();
		})
		header.append(clsBtn);
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

	if (btns.length > 0) {
		let btnBar = document.createElement("div");
		btnBar.classList.add("dialog-window-btns");
		win.append(btnBar);

		for (let btn of btns) {
			let btnEle = document.createElement("button");
			btnEle.innerHTML = btn.name || "";
			btnEle.classList.add("dialog-window-btn");
			btnBar.append(btnEle);

			if (btn.onclick) {
				btnEle.onclick = (e) => {
					btn.onclick && btn.onclick(e, this)
				}
			}
		}
	}

	return base;
}