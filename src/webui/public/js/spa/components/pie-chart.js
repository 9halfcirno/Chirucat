/**
 * 饼图组件
 *
 * 用原生 SVG 绘制占比饼图, 带图例与指针浮窗, 不依赖任何第三方图表库。
 * 数据项约定: { label, value }, value 必须为正数 (非正数会被过滤)。
 *
 * 浮窗说明: 原本用的是 SVG 内嵌 <title>, 那是浏览器原生提示 —— 样式不可控,
 * 移动端也压根不显示。这里改成自绘浮窗:
 * - 鼠标: 悬停扇区即显示, 移出隐藏
 * - 触摸: 点按扇区显示并保持一段时间, 忽略触摸产生的 pointerleave
 *
 * 用法:
 *   const pie = createPieChart({ emptyText: "暂无数据" });
 *   pie.setData([{ label: "QQ", value: 12 }, ...]);
 *   container.appendChild(pie);
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 扇区调色板 */
const COLORS = [
	"#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6",
	"#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6",
];

/** 触摸点按后浮窗保持的时长 (ms) */
const TOUCH_HOLD_MS = 3000;

/** 极坐标 -> 直角坐标 (12 点方向为 0°, 顺时针) */
function polar(cx, cy, r, angleDeg) {
	const rad = ((angleDeg - 90) * Math.PI) / 180;
	return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** 单个扇区的路径 */
function sectorPath(cx, cy, r, start, end) {
	if (end - start >= 360) {
		// 整圆: A 命令同起终点画不出圆, 用两条半圆弧拼
		return [
			`M ${cx} ${cy - r}`,
			`A ${r} ${r} 0 1 1 ${cx} ${cy + r}`,
			`A ${r} ${r} 0 1 1 ${cx} ${cy - r}`,
			"Z",
		].join(" ");
	}
	const s = polar(cx, cy, r, end);
	const e = polar(cx, cy, r, start);
	const large = end - start > 180 ? 1 : 0;
	return [
		`M ${cx} ${cy}`,
		`L ${s.x.toFixed(4)} ${s.y.toFixed(4)}`,
		`A ${r} ${r} 0 ${large} 0 ${e.x.toFixed(4)} ${e.y.toFixed(4)}`,
		"Z",
	].join(" ");
}

export function createPieChart(options = {}) {
	const emptyText = options.emptyText ?? "暂无数据";
	const ariaLabel = options.title ?? "饼图";

	const host = document.createElement("div");
	host.classList.add("pie-chart");

	// 浮窗常驻 DOM, 只切换 hidden —— 这样 draw() 重建内容时它不会被牵连
	const tooltip = document.createElement("div");
	tooltip.classList.add("pie-chart-tooltip");
	tooltip.hidden = true;

	let items = [];
	let touchTimer = null;

	function hideTooltip() {
		tooltip.hidden = true;
	}

	/** 在指针附近显示扇区信息 (位置相对 host 计算并收敛到边界内) */
	function showTooltip(item, ratio, clientX, clientY) {
		const value = Number(item.value).toLocaleString("zh-CN");
		const pct = (ratio * 100).toFixed(1);
		tooltip.textContent = `${item.label} · ${value} (${pct}%)`;
		tooltip.hidden = false;

		const rect = host.getBoundingClientRect();
		const tw = tooltip.offsetWidth;
		const th = tooltip.offsetHeight;

		const localX = clientX - rect.left;
		const localY = clientY - rect.top;

		let left = localX + 12;
		if (left + tw > rect.width - 4) left = localX - tw - 12;
		left = Math.max(4, Math.min(left, rect.width - tw - 4));

		let top = localY - th - 12;
		if (top < 4) top = localY + 16;
		top = Math.max(4, Math.min(top, rect.height - th - 4));

		tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
	}

	function draw() {
		host.replaceChildren(tooltip); // 保留浮窗, 清掉其余内容

		const total = items.reduce((sum, item) => sum + item.value, 0);
		if (items.length === 0 || total <= 0) {
			hideTooltip();
			const empty = document.createElement("p");
			empty.className = "chart-empty";
			empty.textContent = emptyText;
			host.appendChild(empty);
			return;
		}

		const svg = document.createElementNS(SVG_NS, "svg");
		svg.classList.add("pie-chart-svg");
		svg.setAttribute("viewBox", "0 0 100 100");
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", ariaLabel);

		const legend = document.createElement("ul");
		legend.classList.add("pie-chart-legend");

		const cx = 50;
		const cy = 50;
		const r = 42;
		let acc = 0;

		items.forEach((item, i) => {
			const ratio = item.value / total;
			const start = acc;
			const end = acc + ratio * 360;
			acc = end;

			const color = COLORS[i % COLORS.length];
			const summary = `${item.label} · ${Number(item.value).toLocaleString("zh-CN")} (${(ratio * 100).toFixed(1)}%)`;

			const path = document.createElementNS(SVG_NS, "path");
			path.classList.add("pie-chart-slice");
			path.setAttribute("d", sectorPath(cx, cy, r, start, end));
			path.setAttribute("fill", color);
			// 用 aria-label 而不是内嵌 <title>: 后者会弹出原生提示, 与自绘浮窗重叠
			path.setAttribute("aria-label", summary);

			path.addEventListener("pointerenter", e => {
				if (e.pointerType === "touch") return;
				showTooltip(item, ratio, e.clientX, e.clientY);
			});
			path.addEventListener("pointermove", e => {
				if (e.pointerType === "touch") return;
				showTooltip(item, ratio, e.clientX, e.clientY);
			});
			path.addEventListener("pointerleave", e => {
				// 触摸抬起也会派发 pointerleave: 忽略, 交给保持计时器
				if (e.pointerType === "touch") return;
				hideTooltip();
			});
			path.addEventListener("pointerdown", e => {
				showTooltip(item, ratio, e.clientX, e.clientY);
				if (e.pointerType === "touch") {
					clearTimeout(touchTimer);
					touchTimer = setTimeout(hideTooltip, TOUCH_HOLD_MS);
				}
			});

			svg.appendChild(path);

			const li = document.createElement("li");
			const swatch = document.createElement("span");
			swatch.className = "pie-chart-swatch";
			swatch.style.background = color;
			const name = document.createElement("span");
			name.className = "pie-chart-name";
			name.textContent = item.label;
			name.title = item.label;
			const pct = document.createElement("span");
			pct.className = "pie-chart-pct";
			pct.textContent = `${(ratio * 100).toFixed(1)}%`;
			li.append(swatch, name, pct);
			legend.appendChild(li);
		});

		host.append(svg, legend);
	}

	host.setData = next => {
		items = (next ?? [])
			.map(item => ({ label: String(item.label ?? ""), value: Number(item.value) }))
			.filter(item => Number.isFinite(item.value) && item.value > 0);
		draw();
	};

	draw();
	return host;
}
