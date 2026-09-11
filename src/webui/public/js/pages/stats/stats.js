/**
 * 数据统计页面
 *
 * 展示消息量趋势与分布, 数据来自后端可选的统计模块。
 * 统计未启用 (core.statistics 为 null) 时接口返回 503, 页面直接显示错误提示。
 *
 * 图表复用 spa/components 下的公共组件: 趋势用平滑折线图, 平台占比用饼图。
 */
import { apiFetch } from "../../spa/auth.js";
import { createLineChart } from "../../spa/components/line-chart.js";
import { createPieChart } from "../../spa/components/pie-chart.js";

/** 可选的时间范围, bucketMs 为趋势图分桶粒度 */
const RANGES = [
	{ label: "24 小时", ms: 86_400_000, bucketMs: 3_600_000 },
	{ label: "7 天", ms: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
	{ label: "30 天", ms: 30 * 86_400_000, bucketMs: 86_400_000 },
];

/** 页面卸载时释放当前折线图实例的 ResizeObserver */
let disposeCharts = null;

/** 调用统计接口, 统一处理错误 */
async function query(payload) {
	const res = await apiFetch("/api/get_stats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.err || `HTTP ${res.status}`);
	return data;
}

/** 数字千分位 */
function fmt(n) {
	return typeof n === "number" ? n.toLocaleString("zh-CN") : "-";
}

/** 折线图 X 轴短刻度: 按时间范围选择粒度 */
function axisLabel(date, rangeMs) {
	const pad = n => String(n).padStart(2, "0");
	const md = `${date.getMonth() + 1}/${date.getDate()}`;
	if (rangeMs >= 30 * 86_400_000) return md;
	if (rangeMs >= 7 * 86_400_000) return `${md} ${pad(date.getHours())}:00`;
	return `${pad(date.getHours())}:00`;
}

/** 概览卡片 */
function renderCards(box, s) {
	const items = [
		{ label: "消息总数", value: s.total },
		{ label: "活跃用户", value: s.users },
		{ label: "活跃会话", value: s.sessions },
		{ label: "图片", value: s.images },
		{ label: "指令", value: s.commands },
		{ label: "已过滤", value: s.filtered },
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
function rankBlock(title, items, labelOf) {
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

	const max = Math.max(...items.map(i => i.count), 1);

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
function pieCard(title, pie, items, labelOf) {
	const box = document.createElement("div");
	box.className = "stats-rank";

	const head = document.createElement("h3");
	head.textContent = title;
	box.appendChild(head);

	box.appendChild(pie);
	pie.setData((items || []).map(item => ({ label: labelOf(item), value: item.count })));
	return box;
}

export default {
	id: "stats",
	title: "统计",
	icon: "/img/icons/stats.svg",
	styles: ["/js/pages/stats/stats.css"],

	render(container) {
		container.classList.add("stats-page");

		let current = RANGES[0];

		// ---- 时间范围切换 ----
		const bar = document.createElement("div");
		bar.className = "stats-bar";

		const buttons = RANGES.map(range => {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "stats-range";
			btn.textContent = range.label;
			btn.addEventListener("click", () => {
				if (current === range) return;
				current = range;
				syncButtons();
				refresh();
			});
			bar.appendChild(btn);
			return { range, btn };
		});

		const syncButtons = () => {
			for (const { range, btn } of buttons) btn.classList.toggle("active", range === current);
		};
		syncButtons();

		container.appendChild(bar);

		// ---- 概览 ----
		const cards = document.createElement("div");
		cards.className = "stats-cards";
		container.appendChild(cards);

		const notice = document.createElement("p");
		notice.className = "stats-notice";
		notice.hidden = true;
		notice.textContent = "部分历史数据已按小时/天归档, 活跃用户与会话数仅统计明细保留期内的数据。";
		container.appendChild(notice);

		// ---- 趋势: 平滑折线图 ----
		const trendTitle = document.createElement("h3");
		trendTitle.className = "stats-h3";
		trendTitle.textContent = "消息趋势";
		container.appendChild(trendTitle);

		const chartBox = document.createElement("div");
		chartBox.className = "stats-chart";
		const chart = createLineChart({ title: "消息趋势", emptyText: "该时间范围内没有数据" });
		chartBox.appendChild(chart);
		container.appendChild(chartBox);

		// ---- 排名与占比 ----
		const ranks = document.createElement("div");
		ranks.className = "stats-ranks";
		container.appendChild(ranks);

		const platformPie = createPieChart({ title: "平台占比", emptyText: "暂无数据" });
		disposeCharts = () => chart.dispose?.();

		const showError = message => {
			cards.textContent = "";
			chartBox.replaceChildren();
			ranks.textContent = "";
			notice.hidden = true;

			const err = document.createElement("p");
			err.className = "stats-error";
			err.textContent = message;
			container.appendChild(err);
		};

		const refresh = async () => {
			const to = Date.now();
			const from = to - current.ms;
			const range = { from, to };

			try {
				const [summary, timeline, bySession, byPlatform] = await Promise.all([
					query({ target: "summary", ...range }),
					query({ target: "timeline", bucketMs: current.bucketMs, ...range }),
					query({ target: "rank", by: "session", limit: 10, ...range }),
					query({ target: "rank", by: "platform", limit: 10, ...range }),
				]);

				container.querySelector(".stats-error")?.remove();

				renderCards(cards, summary.summary);
				notice.hidden = !summary.summary.partial;

				chartBox.replaceChildren(chart);
				chart.setData((timeline.timeline || []).map(point => {
					const date = new Date(point.time);
					return {
						label: date.toLocaleString("zh-CN"),
						axisLabel: axisLabel(date, current.ms),
						value: point.count,
					};
				}));

				ranks.textContent = "";
				ranks.appendChild(rankBlock("会话 Top 10", bySession.rank, item => {
					const meta = item.meta || {};
					return meta.sessionType ? `${item.id} (${meta.platform || ""} ${meta.sessionType})` : item.id;
				}));
				ranks.appendChild(pieCard("平台 Top 10", platformPie, byPlatform.rank, item => item.id));
			} catch (e) {
				showError(e.message);
			}
		};

		refresh();
	},

	destroy() {
		disposeCharts?.();
		disposeCharts = null;
	},
};
