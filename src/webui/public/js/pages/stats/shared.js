/**
 * 统计页共用件: 整站统计页与 Bot 信息窗的统计子页共用这一份
 *
 * 这里只放"与宿主无关"的部分: 查询封装、时间范围切换条、概览卡片、
 * 图表/排行的卡片外壳。定时刷新、错误提示、页面生命周期留给各自页面 ——
 * 整站页是 SPA 页面 (destroy), Bot 子页是弹窗 (render 返回清理函数)。
 *
 * 样式来自 pages/stats/stats.css, 两个宿主都把它挂进 styles。
 */
import { apiFetch } from "../../spa/auth.js";

/** 可选的时间范围, bucketMs 为趋势图分桶粒度 */
export const RANGES = [
	{ label: "24 小时", ms: 86_400_000, bucketMs: 3_600_000 },
	{ label: "7 天", ms: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
	{ label: "30 天", ms: 30 * 86_400_000, bucketMs: 86_400_000 },
];

/**
 * 调用统计接口, 统一处理错误
 *
 * @param {object} payload 请求体 (target / from / to / bot / bucketMs / by / limit)
 * @returns {Promise<any>}
 */
export async function queryStats(payload) {
	const res = await apiFetch("/api/stats/get", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.err || `HTTP ${res.status}`);
	return data;
}

/** 数字千分位 */
export function fmt(n) {
	return typeof n === "number" ? n.toLocaleString("zh-CN") : "-";
}

/** 折线图 X 轴短刻度: 按时间范围选择粒度 */
export function axisLabel(date, rangeMs) {
	const pad = (n) => String(n).padStart(2, "0");
	const md = `${date.getMonth() + 1}/${date.getDate()}`;
	if (rangeMs >= 30 * 86_400_000) return md;
	if (rangeMs >= 7 * 86_400_000) return `${md} ${pad(date.getHours())}:00`;
	return `${pad(date.getHours())}:00`;
}

/**
 * 时间范围切换条
 *
 * 按钮的选中态由内部维护; 切换时先更新选中态, 再回调调用方去拉数据。
 *
 * @param {{ ranges?: typeof RANGES, initial?: number, onPick?: (range: object) => void }} [opts]
 * @returns {{ el: HTMLElement, current: () => object }}
 */
export function createRangeBar({ ranges = RANGES, initial = 0, onPick } = {}) {
	let current = ranges[initial] ?? ranges[0];

	const bar = document.createElement("div");
	bar.className = "stats-bar";

	const buttons = ranges.map((range) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "stats-range";
		btn.textContent = range.label;
		btn.addEventListener("click", () => {
			if (current === range) return;
			current = range;
			sync();
			onPick?.(range);
		});
		bar.append(btn);
		return { range, btn };
	});

	function sync() {
		for (const { range, btn } of buttons) {
			btn.classList.toggle("active", range === current);
		}
	}
	sync();

	return { el: bar, current: () => current };
}

/** 概览卡片 */
export function renderCards(box, s) {
	const items = [
		{ label: "收到消息", value: s.total },
		{ label: "发出消息", value: s.sent },
		{ label: "活跃用户", value: s.users },
		{ label: "活跃会话", value: s.sessions },
		{ label: "图片", value: s.images },
		{ label: "指令", value: s.commands },
	];

	box.textContent = "";
	for (const item of items) {
		const card = document.createElement("div");
		card.className = "stats-card";

		const value = document.createElement("div");
		value.className = "stats-card-value";
		value.textContent = fmt(item.value);

		const label = document.createElement("div");
		label.className = "stats-card-label";
		label.textContent = item.label;

		card.append(value, label);
		box.appendChild(card);
	}
}

/** 单个排名块: 条形列表 (会话等) */
export function rankBlock(title, items, labelOf) {
	const box = document.createElement("div");
	box.className = "stats-rank";

	const head = document.createElement("h3");
	head.textContent = title;
	box.appendChild(head);

	if (!items || items.length === 0) {
		const empty = document.createElement("p");
		empty.className = "stats-empty";
		empty.textContent = "暂无数据";
		box.appendChild(empty);
		return box;
	}

	const max = Math.max(...items.map((i) => i.count), 1);

	for (const item of items) {
		const row = document.createElement("div");
		row.className = "stats-rank-row";

		const name = document.createElement("span");
		name.className = "stats-rank-name";
		name.textContent = labelOf(item);
		name.title = labelOf(item);

		const track = document.createElement("div");
		track.className = "stats-rank-track";
		const fill = document.createElement("div");
		fill.className = "stats-rank-fill";
		fill.style.width = `${(item.count / max) * 100}%`;
		track.appendChild(fill);

		const count = document.createElement("span");
		count.className = "stats-rank-count";
		count.textContent = fmt(item.count);

		row.append(name, track, count);
		box.appendChild(row);
	}

	return box;
}

/** 饼图卡片: 占比展示 */
export function pieCard(title, pie, items, labelOf) {
	const box = document.createElement("div");
	box.className = "stats-rank";

	const head = document.createElement("h3");
	head.textContent = title;
	box.appendChild(head);

	box.appendChild(pie);
	pie.setData((items || []).map((item) => ({ label: labelOf(item), value: item.count })));
	return box;
}

/** 折线图卡片: 标题 + 固定高度的绘区 */
export function chartCard(title, chart) {
	const box = document.createElement("div");
	box.className = "stats-chart-box";

	const head = document.createElement("h3");
	head.textContent = title;

	const area = document.createElement("div");
	area.className = "stats-chart";
	area.appendChild(chart);

	box.append(head, area);
	return box;
}

/**
 * 把统计结果灌进趋势图
 *
 * 收到与发出共用同一条时间轴, 两次调用只是取不同的字段。
 *
 * @param {HTMLElement} chart createLineChart 的返回值
 * @param {{time: number, count: number, sent: number}[]} points 接口的 timeline
 * @param {(point: object) => number} pick 取哪个字段
 * @param {number} rangeMs 当前时间范围的跨度, 决定轴刻度格式
 */
export function fillTrend(chart, points, pick, rangeMs) {
	chart.setData((points || []).map((point) => {
		const date = new Date(point.time);
		return {
			label: date.toLocaleString("zh-CN"),
			axisLabel: axisLabel(date, rangeMs),
			value: pick(point),
		};
	}));
}
