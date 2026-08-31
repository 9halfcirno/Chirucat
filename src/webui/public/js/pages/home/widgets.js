/**
 * 首页仪表盘: 通用 UI 工厂
 *
 * 创建进度条 / kv 行 / 面板外壳 / 状态项等可复用骨架。
 * 骨架只在首次渲染时创建一次, 后续通过返回的 update / setValue
 * 做增量更新, 避免整块重建 DOM。
 */
import { barColor } from "./format.js";

/**
 * 创建进度条元素; 返回 { bar, update }
 * update(ratio) 只改填充条宽度/颜色, 不重建节点; ratio 非法 (非数字/越界) 时整条置灰
 */
export function createBar(ratio) {
	const bar = document.createElement("div");
	bar.className = "bar";
	const fill = document.createElement("div");
	fill.className = "bar-fill";
	bar.append(fill);

	/** @param {number} r 占用率 0~1 */
	const update = (r) => {
		if (Number.isFinite(r)) {
			fill.classList.remove("bar-fill-na");
			const pct = Math.max(0, Math.min(1, r)) * 100;
			fill.style.width = `${pct}%`;
			fill.style.background = barColor(r);
		} else {
			// 数据缺失: 置灰占位条, 并清掉之前可能残留的内联样式
			fill.classList.add("bar-fill-na");
			fill.style.width = "";
			fill.style.background = "";
		}
	};
	update(ratio);
	return { bar, update };
}

/** 创建一行 kv 文本; 返回 { row, setValue }, setValue 只改右侧数值 */
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
	return { row, setValue(text) { v.textContent = text; } };
}

/**
 * 创建板块外壳
 * setFoot: 首次调用创建脚注, 之后只更新文本 (不会叠加多个 footer)
 * @param {string} title 板块标题
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

/** 创建单个状态项: 状态点 + 文本 */
export function createStatusItem(label) {
	const item = document.createElement("span");
	item.className = "status-item";

	const dot = document.createElement("span");
	dot.className = "dot";

	const text = document.createElement("span");
	text.className = "status-text";
	text.textContent = label;

	item.append(dot, text);
	return { item, dot, text };
}
