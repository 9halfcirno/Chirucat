/**
 * Bot 面板 · 日志页
 *
 * 只显示当前 Bot 的日志:
 * - 订阅 `/api/log/stream?tag=<bot.id>` —— Bot 的 Logger 以 `bot.id` 作为 tag
 *   (见 bot.ts 的 `new Logger(..., { tag: config.id })`), 服务端对历史回放
 *   与实时推送都按该 tag 过滤
 * - 等级筛选在前端做: 每行带级别 class, 切换只翻可见性, 不重建 DOM
 *
 * 渲染沿用整页日志 (logs.js) 的类名与配色, 因此直接复用 logs.css;
 * 与整页日志的差别: 没有 Tag 筛选 (已固定为本 Bot), "清空" 只清本页已渲染的
 * 行, 不调 /api/log/clear —— 那会清掉全局历史缓冲, 波及别处正在看的日志。
 *
 * 本页持有 EventSource 与 rAF 句柄, 因此 render 返回清理函数:
 * bot-content.js 在切页 / 关窗时调用它, 避免连接泄漏。
 */
import { createFilterSelect } from "../../../spa/components/filter-select.js"
import { createIconButton } from "../../../spa/components/icon-button.js"

/** 与 utils/logger.ts 的 LOG_LEVELS 保持一致 */
const LOG_LEVELS = ["debug", "info", "warn", "error"]

/** 行数上限: 长时间挂在窗口里也不会累积过多 DOM */
const MAX_LINES = 2000

export default {
	icon: "/img/icons/log.svg",
	title: "日志",
	styles: ["/js/pages/logs/logs.css"],

	/**
	 * @param {HTMLElement} div 面板内容容器
	 * @param {{ id: string, name?: string | null }} bot
	 * @returns {() => void} 清理函数 (关闭 SSE / 取消排队 / 收起筛选浮层)
	 */
	render(div, bot) {
		div.replaceChildren()

		const page = document.createElement("div")
		page.className = "logs-page bot-log"

		// ---- 顶行: 连接状态 + 等级筛选 + 清空 ----
		const head = document.createElement("div")
		head.className = "logs-head"

		const statusDot = document.createElement("span")
		statusDot.className = "dot off"

		const statusText = document.createElement("span")
		statusText.textContent = "连接中"

		const statusBox = document.createElement("span")
		statusBox.className = "logs-status"
		statusBox.append(statusDot, statusText)

		/** 当前选中的等级 */
		let levels = new Set(LOG_LEVELS)

		const levelFilter = createFilterSelect({
			multiple: true,
			allLabel: "全部等级",
			items: LOG_LEVELS.map((level) => ({ value: level, label: level.toUpperCase() })),
			values: LOG_LEVELS,
			onChange: (values) => {
				levels = new Set(values)
				applyFilters()
			},
		})

		const clearBtn = createIconButton("/img/icons/delete.svg", () => clearList())
		clearBtn.title = "清空当前显示"
		clearBtn.setAttribute("aria-label", "清空当前显示")

		head.append(statusBox, createField("等级", levelFilter.el), clearBtn)

		// ---- 日志列表 ----
		const list = document.createElement("div")
		list.className = "log-list"
		list.setAttribute("role", "log")
		list.setAttribute("aria-label", `Bot ${bot.name || bot.id} 的日志`)

		const empty = document.createElement("p")
		empty.className = "muted logs-empty"
		empty.textContent = "暂无日志"
		list.append(empty)

		page.append(head, list)
		div.append(page)

		// ---- 滚动跟随: 接近底部才自动滚动, 上滚即暂停 ----
		let follow = true
		list.addEventListener("scroll", () => {
			follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24
		})

		let queue = []
		let rafId = null
		let closed = false

		const setStatus = (state, text) => {
			statusDot.className = `dot ${state}`
			statusText.textContent = text
		}

		/** 单行是否命中当前等级筛选 */
		function matchFilter(line) {
			return levels.has(line.dataset.level)
		}

		/** 切换等级筛选: 只翻可见性, 保住滚动位置与历史 */
		function applyFilters() {
			for (const line of list.querySelectorAll(".log-line")) {
				line.hidden = !matchFilter(line)
			}
			syncEmpty()
			if (follow) list.scrollTop = list.scrollHeight
		}

		/** 空态: 一行都没有说"暂无日志", 有但被筛掉说没有匹配。
		 * 逐行看 hidden, 不用 ":not([hidden])" 这类复合选择器 —— 逻辑更直白, 也不挑环境。*/
		function syncEmpty() {
			const placeholder = list.querySelector(".logs-empty")
			if (hasVisibleLine()) {
				placeholder?.remove()
				return
			}

			const text = list.querySelector(".log-line") ? "没有匹配当前等级的日志" : "暂无日志"
			if (placeholder) {
				placeholder.textContent = text
				return
			}

			const created = document.createElement("p")
			created.className = "muted logs-empty"
			created.textContent = text
			list.prepend(created)
		}

		/** 是否有至少一行通过了筛选 */
		function hasVisibleLine() {
			for (const line of list.querySelectorAll(".log-line")) {
				if (!line.hidden) return true
			}
			return false
		}

		/** 清空本页已渲染的行 (不触碰后端全局历史) */
		function clearList() {
			cancelFlush()
			queue = []
			list.replaceChildren()

			const reset = document.createElement("p")
			reset.className = "muted logs-empty"
			reset.textContent = "暂无日志"
			list.append(reset)

			follow = true
			list.scrollTop = 0
		}

		function cancelFlush() {
			if (rafId == null) return
			cancelAnimationFrame(rafId)
			rafId = null
		}

		/** 入队一条日志, 统一在下一帧批量渲染 */
		function enqueue(entry) {
			if (closed) return
			queue.push(entry)
			if (rafId != null) return
			rafId = requestAnimationFrame(flush)
		}

		/** 批量渲染排队中的日志 */
		function flush() {
			rafId = null
			if (closed) {
				queue = []
				return
			}

			const frag = document.createDocumentFragment()
			for (const entry of queue) {
				const level = entry.level ?? "info"
				const line = document.createElement("div")
				line.className = `log-line level-${level}`
				// 过滤只读 dataset, 不必回头找原始条目
				line.dataset.level = level
				line.textContent = `[${entry.time}] [${level.toUpperCase()}] [${entry.name}] ${entry.message}`
				line.hidden = !matchFilter(line)
				frag.append(line)
			}
			queue = []

			list.append(frag)

			// 行数上限, 丢弃最旧的行
			while (list.childElementCount > MAX_LINES) {
				list.removeChild(list.firstElementChild)
			}

			syncEmpty()
			if (follow) list.scrollTop = list.scrollHeight
		}

		// ---- SSE: 只订阅本 Bot 的 tag ----
		const source = new EventSource(`/api/log/stream?tag=${encodeURIComponent(bot.id)}`)
		source.addEventListener("open", () => setStatus("on", "已连接"))
		source.addEventListener("error", () => setStatus("off", "重连中…"))
		source.addEventListener("log", (e) => {
			try {
				enqueue(JSON.parse(e.data))
			} catch (err) {
				console.warn("[bot-logs] 解析日志条目失败:", err)
			}
		})

		/** 清理: 关连接、停排队、收起可能展开的筛选浮层 */
		return () => {
			if (closed) return
			closed = true
			source.close()
			cancelFlush()
			queue = []
			levelFilter.close()
		}
	},
}

/** 带小标签的筛选字段 (与整页日志一致) */
function createField(label, control) {
	const wrap = document.createElement("div")
	wrap.className = "logs-field"

	const name = document.createElement("span")
	name.className = "logs-field-label"
	name.textContent = label

	wrap.append(name, control)
	return wrap
}
