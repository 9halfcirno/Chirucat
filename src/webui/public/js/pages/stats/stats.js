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
import { createLineChart } from "../../spa/components/line-chart.js";
import { createPieChart } from "../../spa/components/pie-chart.js";
import {
	createRangeBar,
	chartCard,
	fillTrend,
	pieCard,
	queryStats,
	renderCards,
} from "./shared.js";

/** 自动刷新间隔 (ms) */
const REFRESH_TIME = 5_000;

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

export default {
	id: "stats",
	title: "统计",
	icon: "/img/icons/stats.svg",
	styles: ["/js/pages/stats/stats.css"],

	render(container) {
		container.classList.add("stats-page");

		// 防御: 极端情况下上一次渲染的定时器可能仍在, 先停掉, 避免重复刷新
		stopAutoRefresh();

		/** 在途请求数: 大于 0 时定时刷新跳过本次, 避免请求堆叠 */
		let inFlight = 0;
		/** 请求序号: 只应用最新一次请求的结果, 丢弃被取代的过期结果 */
		let reqSeq = 0;

		// ---- 时间范围切换 ----
		const rangeBar = createRangeBar({ onPick: () => refresh({ force: true }) });
		container.appendChild(rangeBar.el);

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

			const current = rangeBar.current();
			const to = Date.now();
			const from = to - current.ms;
			const range = { from, to };

			try {
				const [summary, timeline, byPlatform, byCommand] = await Promise.all([
					queryStats({ target: "summary", ...range }),
					queryStats({ target: "timeline", bucketMs: current.bucketMs, ...range }),
					queryStats({ target: "rank", by: "platform", limit: 10, ...range }),
					queryStats({ target: "commands", limit: 10, ...range }),
				]);

				// 已有更新的请求在途 (如刚切换了时间范围): 丢弃过期结果
				if (id !== reqSeq) return;

				clearError();

				renderCards(cards, summary.summary);
				notice.hidden = !summary.summary.partial;

				// 收到与发出共用同一条时间轴
				const points = timeline.timeline || [];
				fillTrend(recvChart, points, point => point.count, current.ms);
				fillTrend(sentChart, points, point => point.sent, current.ms);

				ranks.textContent = "";
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
