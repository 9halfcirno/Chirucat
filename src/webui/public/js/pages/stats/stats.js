/**
 * 数据统计页面
 *
 * 展示消息量趋势与分布, 数据来自后端可选的统计模块。
 * 统计未启用 (core.statistics 为 null) 时接口返回 503, 页面直接显示错误提示。
 *
 * 数据每 5s 自动刷新一次 (与首页保持一致), 切换时间范围时立即刷新。
 * 页面卸载 (destroy) 时停止定时器, 避免离开页面后仍在后台拉取数据。
 *
 * 图表复用 spa/components 下的公共组件: 趋势用平滑折线图(收到 / 发出各一张),
 * 平台与指令命中用饼图。
 */
import { apiFetch } from "../../spa/auth.js";
import { createLineChart } from "../../spa/components/line-chart.js";
import { createPieChart } from "../../spa/components/pie-chart.js";

/** 自动刷新间隔 (ms) */
const REFRESH_TIME = 5_000;

/** 可选的时间范围, bucketMs 为趋势图分桶粒度 */
const RANGES = [
	{ label: "24 小时", ms: 86_400_000, bucketMs: 3_600_000 },
	{ label: "7 天", ms: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
	{ label: "30 天", ms: 30 * 86_400_000, bucketMs: 86_400_000 },
];

/** 页面卸载时释放当前折线图实例的 ResizeObserver */
let disposeCharts = null;

/** 当前页面的自动刷新定时器句柄, destroy 时清除 */
let refreshTimer = null;

/** 停止自动刷新 (可重复调用) */
function stopAutoRefresh() {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
}

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
		{ label: "收到消息", value: s.total },
		{ label: "发出消息", value: s.sent },
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

/* 饼图卡片: 占比展示 */
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

/** 折线图卡片: 标题 + 固定高度的绘区 */
function chartCard(title, chart) {
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

export default {
	id: "stats",
	title: "统计",
	icon: "/img/icons/stats.svg",
	styles: ["/js/pages/stats/stats.css"],

	render(container) {
		container.classList.add("stats-page");

		// 防御: 极端情况下上一次渲染的定时器可能仍在, 先停掉, 避免重复刷新
		stopAutoRefresh();

		let current = RANGES[0];

		/** 在途请求数: 大于 0 时定时刷新跳过本次, 避免请求堆叠 */
		let inFlight = 0;
		/** 请求序号: 只应用最新一次请求的结果, 丢弃被取代的过期结果 */
		let reqSeq = 0;

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
				refresh({ force: true });
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
		notice.textContent = "部分历史数据已按小时/天归档, 活跃用户、会话与图片数仅统计明细保留期内的数据。";
		container.appendChild(notice);

		// ---- 趋势: 平滑折线图 (收到 / 发出) ----
		const trends = document.createElement("div");
		trends.className = "stats-charts";
		container.appendChild(trends);

		const recvChart = createLineChart({ title: "收到消息趋势", emptyText: "该时间范围内没有数据" });
		const sentChart = createLineChart({ title: "发送消息趋势", emptyText: "该时间范围内没有数据" });
		trends.append(
			chartCard("收到消息趋势", recvChart),
			chartCard("发送消息趋势", sentChart),
		);

		// ---- 排名与占比 ----
		const ranks = document.createElement("div");
		ranks.className = "stats-ranks";
		container.appendChild(ranks);

		const platformPie = createPieChart({ title: "平台占比", emptyText: "暂无数据" });
		const commandPie = createPieChart({ title: "指令命中占比", emptyText: "暂无数据" });
		disposeCharts = () => {
			recvChart.dispose?.();
			sentChart.dispose?.();
		};

		/** 移除页面上的错误提示 (定时刷新会反复出错, 不清除会不断累积) */
		const clearError = () => {
			container.querySelectorAll(".stats-error").forEach(el => el.remove());
		};

		const showError = message => {
			cards.textContent = "";
			trends.textContent = "";
			ranks.textContent = "";
			notice.hidden = true;

			clearError();
			const err = document.createElement("p");
			err.className = "stats-error";
			err.textContent = message;
			container.appendChild(err);
		};

		/**
		 * 拉取并渲染统计数据。
		 * @param {{ force?: boolean }} [opts] force=true 时忽略在途请求立即发起 (用户操作)
		 */
		const refresh = async ({ force = false } = {}) => {
			if (inFlight > 0 && !force) return;

			const id = ++reqSeq;
			inFlight++;

			const to = Date.now();
			const from = to - current.ms;
			const range = { from, to };

			try {
				const [summary, timeline, bySession, byPlatform, byCommand] = await Promise.all([
					query({ target: "summary", ...range }),
					query({ target: "timeline", bucketMs: current.bucketMs, ...range }),
					query({ target: "rank", by: "session", limit: 10, ...range }),
					query({ target: "rank", by: "platform", limit: 10, ...range }),
					query({ target: "commands", limit: 10, ...range }),
				]);

				// 已有更新的请求在途 (如刚切换了时间范围): 丢弃过期结果
				if (id !== reqSeq) return;

				clearError();

				renderCards(cards, summary.summary);
				notice.hidden = !summary.summary.partial;

				// 收到与发出共用同一条时间轴
				const points = timeline.timeline || [];
				const toPoints = pick => points.map(point => {
					const date = new Date(point.time);
					return {
						label: date.toLocaleString("zh-CN"),
						axisLabel: axisLabel(date, current.ms),
						value: pick(point),
					};
				});
				recvChart.setData(toPoints(point => point.count));
				sentChart.setData(toPoints(point => point.sent));

				ranks.textContent = "";
				// ranks.appendChild(rankBlock("会话 Top 10", bySession.rank, item => {
				// 	const meta = item.meta || {};
				// 	return meta.sessionType ? `${item.id} (${meta.platform || ""} ${meta.sessionType})` : item.id;
				// }));
				ranks.appendChild(pieCard("平台 Top 10", platformPie, byPlatform.rank, item => item.id));
				ranks.appendChild(pieCard("指令命中 Top 10", commandPie, byCommand.commands, item => item.id));
			} catch (e) {
				if (id !== reqSeq) return;
				showError(e.message);
			} finally {
				inFlight--;
			}
		};

		refresh();
		refreshTimer = setInterval(() => refresh(), REFRESH_TIME);
	},

	destroy() {
		stopAutoRefresh();
		disposeCharts?.();
		disposeCharts = null;
	},
};
