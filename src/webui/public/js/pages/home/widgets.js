/**
 * 首页仪表盘: 通用 UI 工厂
 *
 * 面板外壳与 kv 行这类骨架只在首次渲染时创建一次, 之后通过返回的
 * setValue / setFoot 做增量更新, 避免整块重建 DOM。
 *
 * 环图在 ring.js (自成一体, 逻辑比这几个工厂复杂得多)。
 */

/**
 * 创建一行 kv 文本; 返回 { row, setValue }, setValue 只改右侧数值
 * row.hidden 可整行隐藏 (数据不存在时不留一条空行)
 */
export function createKV(key, value) {
	const row = document.createElement("div");
	row.className = "kv";
	const k = document.createElement("span");
	k.className = "k";
	k.textContent = key;
	const v = document.createElement("span");
	v.className = "v";
	v.textContent = value;
	row.append(k, v);
	return {
		row,
		setValue(text) {
			v.textContent = text;
		},
	};
}

/**
 * 创建板块外壳
 * setFoot: 首次调用创建脚注, 之后只更新文本 (不会叠加多个 footer)
 * @param {string} title 板块标题 (字符画里每个方框顶部的名字)
 * @returns {{ section: HTMLElement, body: HTMLElement, setFoot: (text: string) => void }}
 */
export function createPanel(title) {
	const section = document.createElement("section");
	section.className = "card panel";

	const head = document.createElement("header");
	head.className = "panel-head";

	const titleEl = document.createElement("span");
	titleEl.className = "panel-title";
	titleEl.textContent = title;
	head.append(titleEl);

	const body = document.createElement("div");
	body.className = "panel-body";

	section.append(head, body);

	let footEl = null;
	return {
		section,
		body,
		setFoot(text) {
			if (!footEl) {
				footEl = document.createElement("footer");
				footEl.className = "panel-foot";
				section.append(footEl);
			}
			footEl.textContent = text;
		},
	};
}
