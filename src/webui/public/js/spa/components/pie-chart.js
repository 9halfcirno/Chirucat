/**
 * 饼图组件
 *
 * 用原生 SVG 绘制占比饼图, 带图例与悬停提示, 不依赖任何第三方图表库。
 * 数据项约定: { label, value }, value 必须为正数 (非正数会被过滤)。
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

	let items = [];

	function draw() {
		host.replaceChildren();

		const total = items.reduce((sum, item) => sum + item.value, 0);
		if (items.length === 0 || total <= 0) {
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

			const path = document.createElementNS(SVG_NS, "path");
			path.classList.add("pie-chart-slice");
			path.setAttribute("d", sectorPath(cx, cy, r, start, end));
			path.setAttribute("fill", COLORS[i % COLORS.length]);
			const title = document.createElementNS(SVG_NS, "title");
			title.textContent = `${item.label} · ${Number(item.value).toLocaleString("zh-CN")} (${(ratio * 100).toFixed(1)}%)`;
			path.appendChild(title);
			svg.appendChild(path);

			const li = document.createElement("li");
			const swatch = document.createElement("span");
			swatch.className = "pie-chart-swatch";
			swatch.style.background = COLORS[i % COLORS.length];
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
