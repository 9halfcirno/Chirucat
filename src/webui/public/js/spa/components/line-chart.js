/**
 * 平滑折线图组件
 *
 * 用原生 SVG 绘制平滑趋势线 (Catmull-Rom 样条转三次贝塞尔), 带渐变面积填充、
 * X/Y 轴刻度、水平网格线与指针浮窗, 不依赖任何第三方图表库。
 * 图表随容器尺寸自适应 (ResizeObserver)。
 *
 * 数据点约定: { label, axisLabel?, value }
 *   - label     浮窗中展示的完整标签 (如完整时间)
 *   - axisLabel X 轴刻度使用的短标签 (可选, 缺省回退到 label)
 *   - value     数值, 用于纵向定位
 *
 * 两条容易踩的坑, 这里都做了处理:
 *
 * 1. 样条过冲。Catmull-Rom 的控制点由前后相邻点外推得出, 数据急变时曲线会
 *    冲出数据点的取值范围 (值很小或很大时尤其明显)。除了把 Y 轴上限抬到
 *    "好看的刻度"(见 niceScale) 留出余量, 还给折线与面积加了 clipPath 兜底,
 *    保证任何数据下都不会画出绘图区。
 *
 * 2. 移动端浮窗。触摸屏没有 hover: 手指抬起会派发 pointerleave, 若照搬鼠标
 *    那套 (move 显示 / leave 隐藏) 就会"闪一下就消失"。所以触摸走 pointerdown
 *    点按显示并保持一段时间, 且忽略触摸产生的 pointerleave。
 *
 * 用法:
 *   const chart = createLineChart({ emptyText: "暂无数据" });
 *   chart.setData([{ label: "2026-09-11 12:00", axisLabel: "12:00", value: 3 }]);
 *   container.appendChild(chart);
 *   chart.dispose(); // 不再使用时释放 ResizeObserver 与全局监听
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 渐变资源 id 后缀: 避免同页多个实例互相覆盖 */
let uid = 0;

/** 触摸点按后浮窗保持的时长 (ms) */
const TOUCH_HOLD_MS = 3000;

const PAD_TOP = 10;
const PAD_BOTTOM = 6;
const PAD_X = 6;

/** 折线点列 -> 平滑三次贝塞尔路径 (Catmull-Rom 转 Bezier) */
function smoothPath(pts) {
	if (pts.length === 0) return "";
	const parts = [`M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`];
	for (let i = 0; i < pts.length - 1; i++) {
		const p0 = pts[i - 1] ?? pts[i];
		const p1 = pts[i];
		const p2 = pts[i + 1];
		const p3 = pts[i + 2] ?? p2;
		const c1x = p1.x + (p2.x - p0.x) / 6;
		const c1y = p1.y + (p2.y - p0.y) / 6;
		const c2x = p2.x - (p3.x - p1.x) / 6;
		const c2y = p2.y - (p3.y - p1.y) / 6;
		parts.push(
			`C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
		);
	}
	return parts.join(" ");
}

/** 从 n 个点中抽取至多 max 个等距索引 (升序去重) */
function sampleTicks(n, max) {
	if (n <= max) return Array.from({ length: n }, (_, i) => i);
	const ticks = [];
	for (let i = 0; i < max; i++) {
		ticks.push(Math.round((i / (max - 1)) * (n - 1)));
	}
	return [...new Set(ticks)];
}

/**
 * 计算 Y 轴范围与刻度
 *
 * 步长取 1/2/5 × 10^n, 轴上限向上取整到步长的整数倍。这样:
 * - 最高点不会贴着顶端, 而是留出一档余量 (也让样条过冲不那么容易超出)
 * - 刻度值是 0 / 5 / 10 这类整数, 而不是 3.7 这种读不出意义的数
 *
 * 导出以便单元测试。
 *
 * @param {number} maxValue 数据最大值
 * @param {number} [targetTicks] 期望的刻度档数
 * @returns {{ max: number, ticks: number[] }}
 */
export function niceScale(maxValue, targetTicks = 4) {
	if (!Number.isFinite(maxValue) || maxValue <= 0) {
		return { max: 1, ticks: [0, 1] };
	}

	const rawStep = maxValue / targetTicks;
	const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
	const norm = rawStep / mag;
	const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
	const axisMax = Math.ceil(maxValue / step) * step;

	const ticks = [];
	// 用序号乘步长, 并做一次精度收敛, 避免 0.1 累加出现 0.30000000000000004
	const count = Math.round(axisMax / step);
	for (let i = 0; i <= count; i++) {
		ticks.push(Number((i * step).toPrecision(12)));
	}
	return { max: axisMax, ticks };
}

/**
 * 刻度数值的紧凑写法: 大数用 k/M/B 后缀, 避免 Y 轴标签过长挤占绘图区。
 * 导出以便单元测试。
 */
export function formatValue(v) {
	const abs = Math.abs(v);
	if (abs >= 1e9) return `${Math.round(v / 1e9)}B`;
	if (abs >= 1e6) return `${Math.round(v / 1e6)}M`;
	if (abs >= 1e4) return `${Math.round(v / 1e3)}k`;
	if (Number.isInteger(v)) return String(v);
	return v.toFixed(abs < 1 ? 2 : 1);
}

export function createLineChart(options = {}) {
	const emptyText = options.emptyText ?? "暂无数据";
	const ariaLabel = options.title ?? "折线图";
	const maxXTicks = options.maxTicks ?? 6;

	const host = document.createElement("div");
	host.classList.add("line-chart");

	// 结构: 左侧 Y 轴刻度 | 绘图区 / 下方 X 轴刻度 (由 CSS grid 对齐)
	const yAxis = document.createElement("div");
	yAxis.classList.add("line-chart-yaxis");

	const plot = document.createElement("div");
	plot.classList.add("line-chart-plot");

	const axis = document.createElement("div");
	axis.classList.add("line-chart-axis");

	const tooltip = document.createElement("div");
	tooltip.classList.add("line-chart-tooltip");
	tooltip.hidden = true;
	plot.appendChild(tooltip);

	host.append(yAxis, plot, axis);

	let points = [];
	let coords = []; // 最近一次绘制的数据点坐标 (供浮窗命中)
	let cursorLine = null; // 悬停定位虚线
	let ro = null;
	let disposed = false;
	let touchTimer = null;

	function hideTooltip() {
		tooltip.hidden = true;
		if (cursorLine) cursorLine.style.display = "none";
	}

	/** 根据视口坐标更新浮窗与定位虚线 (命中横向最近的数据点) */
	function updateTooltip(clientX) {
		if (coords.length === 0) return;

		const rect = plot.getBoundingClientRect();
		const mx = clientX - rect.left;

		let idx = 0;
		let best = Infinity;
		for (let i = 0; i < coords.length; i++) {
			const d = Math.abs(coords[i].x - mx);
			if (d < best) {
				best = d;
				idx = i;
			}
		}

		const c = coords[idx];
		const w = plot.clientWidth;

		if (cursorLine) {
			cursorLine.setAttribute("x1", c.x.toFixed(2));
			cursorLine.setAttribute("x2", c.x.toFixed(2));
			cursorLine.style.display = "";
		}

		// 浮窗锚定在数据点上方, 不跟随鼠标
		tooltip.textContent = `${c.label} · ${Number(c.value).toLocaleString("zh-CN")}`;
		tooltip.hidden = false;

		const tw = tooltip.offsetWidth;
		const th = tooltip.offsetHeight;
		let left = c.x - tw / 2;
		left = Math.max(4, Math.min(left, w - tw - 4));
		let top = c.y - th - 8;
		if (top < 4) top = c.y + 8;
		top = Math.min(top, plot.clientHeight - th - 4);

		tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
	}

	function draw() {
		if (disposed) return;
		plot.replaceChildren(tooltip);
		yAxis.replaceChildren();
		axis.replaceChildren();
		cursorLine = null;

		if (points.length === 0) {
			coords = [];
			const empty = document.createElement("p");
			empty.className = "chart-empty";
			empty.textContent = emptyText;
			plot.appendChild(empty);
			return;
		}

		const w = plot.clientWidth;
		const h = plot.clientHeight;
		if (w <= 0 || h <= 0) return; // 尚未布局, 等 ResizeObserver 回调补绘

		const dataMax = Math.max(...points.map(p => p.value));
		const scale = niceScale(dataMax);
		const n = points.length;

		/** 数值 -> 绘图区 y 坐标 (0 在底部, axisMax 在顶部) */
		const valueToY = v => h - PAD_BOTTOM - (v / scale.max) * (h - PAD_TOP - PAD_BOTTOM);

		coords = points.map((p, i) => ({
			...p,
			x: n === 1 ? w / 2 : PAD_X + (i / (n - 1)) * (w - PAD_X * 2),
			y: valueToY(p.value),
		}));

		const line = smoothPath(coords);
		const area =
			n > 1
				? `${line} L ${coords[n - 1].x.toFixed(2)} ${(h - PAD_BOTTOM).toFixed(2)} L ${coords[0].x.toFixed(2)} ${(h - PAD_BOTTOM).toFixed(2)} Z`
				: "";

		const svg = document.createElementNS(SVG_NS, "svg");
		svg.classList.add("line-chart-svg");
		svg.setAttribute("width", w);
		svg.setAttribute("height", h);
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", ariaLabel);

		const defs = document.createElementNS(SVG_NS, "defs");

		// 渐变填充
		const gradId = `line-chart-fill-${++uid}`;
		const grad = document.createElementNS(SVG_NS, "linearGradient");
		grad.setAttribute("id", gradId);
		grad.setAttribute("x1", "0");
		grad.setAttribute("y1", "0");
		grad.setAttribute("x2", "0");
		grad.setAttribute("y2", "1");
		const stopTop = document.createElementNS(SVG_NS, "stop");
		stopTop.setAttribute("offset", "0%");
		stopTop.setAttribute("stop-color", "currentColor");
		stopTop.setAttribute("stop-opacity", "0.28");
		const stopBottom = document.createElementNS(SVG_NS, "stop");
		stopBottom.setAttribute("offset", "100%");
		stopBottom.setAttribute("stop-color", "currentColor");
		stopBottom.setAttribute("stop-opacity", "0");
		grad.append(stopTop, stopBottom);
		defs.appendChild(grad);

		// 裁剪区: 样条在数据急变时会过冲, 这里兜底保证不画出绘图区
		const clipId = `line-chart-clip-${++uid}`;
		const clipPath = document.createElementNS(SVG_NS, "clipPath");
		clipPath.setAttribute("id", clipId);
		const clipRect = document.createElementNS(SVG_NS, "rect");
		clipRect.setAttribute("x", "0");
		clipRect.setAttribute("y", "0");
		clipRect.setAttribute("width", String(w));
		clipRect.setAttribute("height", String(h));
		clipPath.appendChild(clipRect);
		defs.appendChild(clipPath);

		svg.appendChild(defs);

		// 水平网格线: 在折线之前插入, 保证处于下层
		const gridGroup = document.createElementNS(SVG_NS, "g");
		gridGroup.classList.add("line-chart-grid-group");
		for (const t of scale.ticks) {
			const y = valueToY(t);
			const grid = document.createElementNS(SVG_NS, "line");
			grid.classList.add("line-chart-grid");
			grid.setAttribute("x1", "0");
			grid.setAttribute("x2", String(w));
			grid.setAttribute("y1", y.toFixed(2));
			grid.setAttribute("y2", y.toFixed(2));
			gridGroup.appendChild(grid);
		}
		svg.appendChild(gridGroup);

		if (area) {
			const areaPath = document.createElementNS(SVG_NS, "path");
			areaPath.setAttribute("d", area);
			areaPath.setAttribute("fill", `url(#${gradId})`);
			areaPath.setAttribute("stroke", "none");
			areaPath.setAttribute("clip-path", `url(#${clipId})`);
			svg.appendChild(areaPath);
		}

		if (n > 1) {
			const linePath = document.createElementNS(SVG_NS, "path");
			linePath.classList.add("line-chart-line");
			linePath.setAttribute("d", line);
			linePath.setAttribute("clip-path", `url(#${clipId})`);
			svg.appendChild(linePath);
		}

		for (const c of coords) {
			const dot = document.createElementNS(SVG_NS, "circle");
			dot.classList.add("line-chart-dot");
			dot.setAttribute("cx", c.x.toFixed(2));
			dot.setAttribute("cy", c.y.toFixed(2));
			dot.setAttribute("r", "3");
			svg.appendChild(dot);
		}

		// 悬停定位虚线 (默认隐藏, 由指针事件更新位置)
		cursorLine = document.createElementNS(SVG_NS, "line");
		cursorLine.classList.add("line-chart-cursor");
		cursorLine.setAttribute("y1", "0");
		cursorLine.setAttribute("y2", String(h));
		cursorLine.style.display = "none";
		svg.appendChild(cursorLine);

		plot.appendChild(svg);

		// Y 轴刻度: 绝对定位, top 与绘图区的 y 坐标一一对应
		for (const t of scale.ticks) {
			const tick = document.createElement("span");
			tick.classList.add("line-chart-yaxis-tick");
			tick.textContent = formatValue(t);
			tick.style.top = `${valueToY(t).toFixed(2)}px`;
			yAxis.appendChild(tick);
		}

		// X 轴刻度
		for (const i of sampleTicks(n, maxXTicks)) {
			const tick = document.createElement("span");
			tick.classList.add("line-chart-tick");
			tick.textContent = coords[i].axisLabel ?? coords[i].label;
			axis.appendChild(tick);
		}
	}

	// ---- 指针交互 ----
	// 鼠标: 移入跟随, 移出隐藏。
	// 触摸: 没有 hover, 点按显示并保持 TOUCH_HOLD_MS; 触摸产生的 pointerleave 忽略。

	plot.addEventListener("pointerdown", e => {
		if (e.pointerType !== "touch") return;
		updateTooltip(e.clientX);
		clearTimeout(touchTimer);
		touchTimer = setTimeout(hideTooltip, TOUCH_HOLD_MS);
	});

	plot.addEventListener("pointermove", e => {
		if (e.pointerType === "touch") {
			// 手指拖动: 仅在触摸保持期内跟随
			if (touchTimer === null) return;
			updateTooltip(e.clientX);
			return;
		}
		updateTooltip(e.clientX);
	});

	plot.addEventListener("pointerleave", e => {
		// 触摸抬起也会派发 pointerleave: 忽略, 否则浮窗会"闪一下就消失"
		if (e.pointerType === "touch") return;
		hideTooltip();
	});

	/** 点击图表之外收起触摸浮窗 */
	function onDocPointerDown(e) {
		if (!host.contains(e.target)) {
			clearTimeout(touchTimer);
			touchTimer = null;
			hideTooltip();
		}
	}
	document.addEventListener("pointerdown", onDocPointerDown, true);

	ro = new ResizeObserver(() => {
		if (!host.isConnected) {
			ro?.disconnect();
			return;
		}
		draw();
	});
	ro.observe(host);

	host.setData = next => {
		points = (next ?? [])
			.map(p => ({
				label: String(p.label ?? ""),
				axisLabel: p.axisLabel != null ? String(p.axisLabel) : null,
				value: Number(p.value),
			}))
			.filter(p => Number.isFinite(p.value));
		draw();
	};

	host.dispose = () => {
		disposed = true;
		clearTimeout(touchTimer);
		touchTimer = null;
		document.removeEventListener("pointerdown", onDocPointerDown, true);
		ro?.disconnect();
		ro = null;
	};

	draw();
	return host;
}
