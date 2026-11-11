/**
 * Bot 面板 · 统计页
 *
 * 与整站「统计」页同源同貌, 区别只在查询范围: 每次请求都带 `bot: bot.id`,
 * 后端 (api/stats/get → statistics/store 的 #where) 会追加 `AND bot_id = ?`,
 * 因此概览、趋势与排行全部只统计本 Bot 的消息。
 *
 * 后端无需任何改动 —— 统计接口从最初就支持按 Bot 过滤。
 *
 * 页面契约与整站统计页一致, 但这里是弹窗子页:
 * - 定时器、图表实例必须在切页/关窗时释放, 故 render 返回清理函数
 * - 统计模块是可选功能, 未启用时接口 503, 这里把后端原话显示出来
 */
import { createLineChart } from "../../../spa/components/line-chart.js"
import { createPieChart } from "../../../spa/components/pie-chart.js"
import {
	chartCard,
	createRangeBar,
	fillTrend,
	pieCard,
	queryStats,
	renderCards,
} from "../../stats/shared.js"

/** 自动刷新间隔 (ms), 与整站统计页保持一致 */
const REFRESH_TIME = 5_000

export default {
	icon: "/img/icons/stats.svg",
	title: "统计",
	styles: ["/js/pages/stats/stats.css"],

	/**
	 * @param {HTMLElement} div 面板内容容器
	 * @param {{ id: string, name?: string | null }} bot
	 * @returns {() => void} 清理函数 (停定时器 / 释放图表)
	 */
	render(div, bot) {
		div.replaceChildren()

		const page = document.createElement("div")
		page.className = "stats-page"

		/** 在途请求数: 大于 0 时定时刷新跳过本次, 避免请求堆叠 */
		let inFlight = 0
		/** 请求序号: 只应用最新一次请求的结果, 丢弃被取代的过期结果 */
		let reqSeq = 0
		let closed = false
		let timer = null

		// ---- 时间范围切换 ----
		const rangeBar = createRangeBar({ onPick: () => refresh({ force: true }) })

		// ---- 概览 ----
		const cards = document.createElement("div")
		cards.className = "stats-cards"

		const notice = document.createElement("p")
		notice.className = "stats-notice"
		notice.hidden = true
		notice.textContent = "部分历史数据已按小时/天归档, 活跃用户、会话与图片数仅统计明细保留期内的数据。"

		// ---- 趋势: 收到 / 发出 ----
		const trends = document.createElement("div")
		trends.className = "stats-charts"

		const recvChart = createLineChart({ title: "收到消息趋势", emptyText: "该时间范围内没有数据" })
		const sentChart = createLineChart({ title: "发送消息趋势", emptyText: "该时间范围内没有数据" })
		trends.append(
			chartCard("收到消息趋势", recvChart),
			chartCard("发送消息趋势", sentChart),
		)

		// ---- 占比 ----
		const ranks = document.createElement("div")
		ranks.className = "stats-ranks"

		const platformPie = createPieChart({ title: "平台占比", emptyText: "暂无数据" })
		const commandPie = createPieChart({ title: "指令命中占比", emptyText: "暂无数据" })

		page.append(rangeBar.el, cards, notice, trends, ranks)
		div.append(page)

		/** 移除页面上的错误提示 (定时刷新会反复出错, 不清除会不断累积) */
		function clearError() {
			for (const el of page.querySelectorAll(".stats-error")) el.remove()
		}

		function showError(message) {
			cards.textContent = ""
			trends.textContent = ""
			ranks.textContent = ""
			notice.hidden = true

			clearError()
			const err = document.createElement("p")
			err.className = "stats-error"
			err.textContent = message
			page.append(err)
		}

		/**
		 * 拉取并渲染本 Bot 的统计数据
		 * @param {{ force?: boolean }} [opts] force=true 时忽略在途请求立即发起 (用户操作)
		 */
		async function refresh({ force = false } = {}) {
			if (closed) return
			if (inFlight > 0 && !force) return

			const id = ++reqSeq
			inFlight++

			const current = rangeBar.current()
			const to = Date.now()
			const from = to - current.ms
			// bot 字段把四类查询都限定在本 Bot 上
			const range = { from, to, bot: bot.id }

			try {
				const [summary, timeline, byPlatform, byCommand] = await Promise.all([
					queryStats({ target: "summary", ...range }),
					queryStats({ target: "timeline", bucketMs: current.bucketMs, ...range }),
					queryStats({ target: "rank", by: "platform", limit: 10, ...range }),
					queryStats({ target: "commands", limit: 10, ...range }),
				])

				// 页面已关闭, 或已有更新的请求在途: 丢弃这次结果
				if (closed || id !== reqSeq) return

				clearError()

				renderCards(cards, summary.summary)
				notice.hidden = !summary.summary.partial

				const points = timeline.timeline || []
				fillTrend(recvChart, points, (point) => point.count, current.ms)
				fillTrend(sentChart, points, (point) => point.sent, current.ms)

				ranks.textContent = ""
				ranks.append(
					pieCard("平台 Top 10", platformPie, byPlatform.rank, (item) => item.id),
					pieCard("指令命中 Top 10", commandPie, byCommand.commands, (item) => item.id),
				)
			} catch (e) {
				if (closed || id !== reqSeq) return
				showError(e.message)
			} finally {
				inFlight--
			}
		}

		void refresh()
		timer = setInterval(() => void refresh(), REFRESH_TIME)

		// 清理: 停刷新、释放图表的 ResizeObserver 与全局监听
		return () => {
			if (closed) return
			closed = true
			if (timer) {
				clearInterval(timer)
				timer = null
			}
			recvChart.dispose?.()
			sentChart.dispose?.()
		}
	},
}
