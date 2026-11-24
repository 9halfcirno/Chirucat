/**
 * 首页: 环形图
 *
 * 单层或多层同心圆环, 中心显示主数值 (如 "12%")。多层的用途是「叠加对比」——
 * 首页内存就是这个用法: 外环系统已用, 内环进程 RSS, 同一基准下比较两个量。
 *
 * 画法: 每个刻度是一条整圆 <circle>, 配上 pathLength="100" 后, 圆周就被
 * 归一化成 100 份 —— 弧长直接写成 `stroke-dasharray: <百分比> 100`,
 * 更新时只改这一个属性, 不必像扇区那样重算路径。过渡交给 CSS。
 *
 * 只被首页使用, 因此放在页面目录而不是 spa/components; 若别的页面也要用,
 * 再上移并在 css/components/charts.css 里补样式。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 环宽 (viewBox 单位) 与层间距; 需与 home.css 的 stroke-width 保持一致 */
const STROKE_W = 8;
const LAYER_GAP = 3;

/** 创建一条整圆 (无填充, 描边由 CSS 类给) */
function createCircle(r, className) {
	const c = document.createElementNS(SVG_NS, "circle");
	c.setAttribute("cx", "50");
	c.setAttribute("cy", "50");
	c.setAttribute("r", String(r));
	c.setAttribute("class", className);
	return c;
}

/** 创建居中文字: 只给 y 与类名, 水平/垂直居中由 CSS (text-anchor / dominant-baseline) 负责 */
function createText(y, className) {
	const t = document.createElementNS(SVG_NS, "text");
	t.setAttribute("x", "50");
	t.setAttribute("y", String(y));
	t.setAttribute("class", className);
	return t;
}

/**
 * 创建环形图
 *
 * @param {object} [options]
 * @param {string[]} [options.layers] 每一层的描边颜色 (CSS 颜色或 var()), 由外向内
 * @param {string} [options.label] 无障碍描述 (屏幕阅读器读的名字)
 * @param {string} [options.sub] 初始副标签
 * @returns {{ element: HTMLElement, update: (data: { values?: (number|null)[], text?: string, sub?: string }) => void }}
 *   values 与 layers 一一对应, 取值 0~1; 传 null / 非数字表示该层无数据 (不画弧)
 */
export function createRing({ layers = ["var(--accent)"], label = "环形图" } = {}) {
	const host = document.createElement("div");
	host.className = "ring";

	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 100 100");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", label);
	svg.classList.add("ring-svg");

	// 弧从 12 点方向起顺时针: 整组转 -90°, 省得每条弧自己算起点
	const g = document.createElementNS(SVG_NS, "g");
	g.setAttribute("transform", "rotate(-90 50 50)");

	// 层半径由外向内排: 最外层留 1 单位余量, 免得描边被 viewBox 裁掉
	const radii = layers.map((_, i) => 50 - 1 - STROKE_W / 2 - i * (STROKE_W + LAYER_GAP));

	const arcs = radii.map((r, i) => {
		// 轨道常驻 (浅色底环), 弧叠在它上面 —— 弧占比为 0 时也能看出「这里有个环」
		g.append(createCircle(r, "ring-track"));

		const arc = createCircle(r, "ring-arc");
		arc.setAttribute("pathLength", "100");
		arc.setAttribute("stroke-dasharray", "0 100");
		arc.setAttribute("stroke", layers[i]);
		g.append(arc);
		return arc;
	});

	svg.append(g);

	// 中心文字: 数值在上, 副标签在下 (多层环的中心圆较小, 字号已在 CSS 里压低)
	const text = createText(46, "ring-text");
	const sub = createText(61, "ring-sub");
	svg.append(text, sub);

	host.append(svg);

	let currentSub = "";

	const update = ({ values = [], text: mainText = "", sub: subText } = {}) => {
		for (let i = 0; i < arcs.length; i++) {
			const raw = values[i];
			const ratio = Number(raw);

			// 数据缺失: 弧长归零, 只留底环 (比画一条半截弧更诚实)
			if (raw == null || !Number.isFinite(ratio)) {
				arcs[i].setAttribute("stroke-dasharray", "0 100");
				continue;
			}

			const pct = Math.max(0, Math.min(1, ratio)) * 100;
			arcs[i].setAttribute("stroke-dasharray", `${pct.toFixed(2)} 100`);
		}

		text.textContent = mainText;

		// 副标签没传就沿用上一次的 (刷新时只更新数值, 不必每帧重复写标签)
		if (subText != null) {
			currentSub = subText;
			sub.textContent = subText;
		}
		sub.style.display = currentSub ? "" : "none";
	};

	update({ values: [], text: "" });

	return { element: host, update };
}
