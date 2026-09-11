/**
 * 平滑折线图组件
 *
 * 用原生 SVG 绘制平滑趋势线 (Catmull-Rom 样条转三次贝塞尔), 带渐变面积
 * 填充、X 轴时间刻度与鼠标最近点浮窗, 不依赖任何第三方图表库。图表随
 * 容器尺寸自适应 (ResizeObserver)。
 *
 * 数据点约定: { label, axisLabel?, value }
 *   - label     浮窗中展示的完整标签 (如完整时间)
 *   - axisLabel X 轴刻度使用的短标签 (可选, 缺省回退到 label)
 *   - value     数值, 用于纵向定位
 *
 * 用法:
 *   const chart = createLineChart({ emptyText: "暂无数据" });
 *   chart.setData([{ label: "2026-09-11 12:00", axisLabel: "12:00", value: 3 }]);
 *   container.appendChild(chart);
 *   chart.dispose(); // 不再使用时释放 ResizeObserver
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 渐变资源 id 后缀: 避免同页多个实例互相覆盖 */
let uid = 0;

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

export function createLineChart(options = {}) {
	const emptyText = options.emptyText ?? "暂无数据";
	const ariaLabel = options.title ?? "折线图";
	const maxTicks = options.maxTicks ?? 6;

	const host = document.createElement("div");
	host.classList.add("line-chart");

	// 结构: 折线区域 + X 轴刻度, 浮窗绝对定位在折线区域之上
	const plot = document.createElement("div");
	plot.classList.add("line-chart-plot");
	const axis = document.createElement("div");
	axis.classList.add("line-chart-axis");
	const tooltip = document.createElement("div");
	tooltip.classList.add("line-chart-tooltip");
	tooltip.hidden = true;
	plot.appendChild(tooltip);
	host.append(plot, axis);

	let points = [];
	let coords = []; // 最近一次绘制的数据点坐标 (供浮窗命中)
	let cursorLine = null; // 悬停定位虚线
	let ro = null;
	let disposed = false;

	function draw() {
		if (disposed) return;
		plot.replaceChildren(tooltip);
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

		const padTop = 10;
		const padBottom = 6;
		const padX = 6;
		const max = Math.max(...points.map(p => p.value), 1);
		const n = points.length;

		coords = points.map((p, i) => ({
			...p,
			x: n === 1 ? w / 2 : padX + (i / (n - 1)) * (w - padX * 2),
			y: h - padBottom - (p.value / max) * (h - padTop - padBottom),
		}));

		const line = smoothPath(coords);
		const area =
			n > 1
				? `${line} L ${coords[n - 1].x.toFixed(2)} ${(h - padBottom).toFixed(2)} L ${coords[0].x.toFixed(2)} ${(h - padBottom).toFixed(2)} Z`
				: "";

		const svg = document.createElementNS(SVG_NS, "svg");
		svg.classList.add("line-chart-svg");
		svg.setAttribute("width", w);
		svg.setAttribute("height", h);
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", ariaLabel);

		const gradId = `line-chart-fill-${++uid}`;
		const defs = document.createElementNS(SVG_NS, "defs");
		const grad = document.createElementNS(SVG_NS, "linearGradient");
		grad.setAttribute("id", gradId);
		grad.setAttribute("x1", "0");
		grad.setAttribute("y1", "0");
		grad.setAttribute("x2", "0");
		grad.setAttribute("y2", "1");
		const stopTop = document.createElementNS(SVG_NS, "stop");
		stopTop.setAttribute("offset", "0%");
		stopTop.setAttribute("stop-color", "#3b82f6");
		stopTop.setAttribute("stop-opacity", "0.28");
		const stopBottom = document.createElementNS(SVG_NS, "stop");
		stopBottom.setAttribute("offset", "100%");
		stopBottom.setAttribute("stop-color", "#3b82f6");
		stopBottom.setAttribute("stop-opacity", "0");
		grad.append(stopTop, stopBottom);
		defs.appendChild(grad);
		svg.appendChild(defs);

		if (area) {
			const areaPath = document.createElementNS(SVG_NS, "path");
			areaPath.setAttribute("d", area);
			areaPath.setAttribute("fill", `url(#${gradId})`);
			areaPath.setAttribute("stroke", "none");
			svg.appendChild(areaPath);
		}

		if (n > 1) {
			const linePath = document.createElementNS(SVG_NS, "path");
			linePath.classList.add("line-chart-line");
			linePath.setAttribute("d", line);
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

		// 悬停定位虚线 (默认隐藏, 由 pointermove 更新位置)
		cursorLine = document.createElementNS(SVG_NS, "line");
		cursorLine.classList.add("line-chart-cursor");
		cursorLine.setAttribute("y1", "0");
		cursorLine.setAttribute("y2", String(h));
		cursorLine.style.display = "none";
		svg.appendChild(cursorLine);

		plot.appendChild(svg);

		// X 轴时间刻度
		for (const i of sampleTicks(n, maxTicks)) {
			const tick = document.createElement("span");
			tick.className = "line-chart-tick";
			tick.textContent = coords[i].axisLabel ?? coords[i].label;
			axis.appendChild(tick);
		}
	}

	plot.addEventListener("pointermove", e => {
		if (coords.length === 0) return;
		const rect = plot.getBoundingClientRect();
		const mx = e.clientX - rect.left;

		// 命中横坐标最近的数据点
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

		// 定位虚线: 落在最近数据点的横坐标上
		if (cursorLine) {
			cursorLine.setAttribute("x1", c.x.toFixed(2));
			cursorLine.setAttribute("x2", c.x.toFixed(2));
			cursorLine.style.display = "";
		}

		// 浮窗: 锚定在数据点上方, 不跟随鼠标
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
	});

	plot.addEventListener("pointerleave", () => {
		tooltip.hidden = true;
		if (cursorLine) cursorLine.style.display = "none";
	});

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
		ro?.disconnect();
		ro = null;
	};

	draw();
	return host;
}
