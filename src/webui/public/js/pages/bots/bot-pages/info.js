/**
 * Bot 面板 · 信息页
 *
 * 展示该 Bot 的身份与运行概况:
 * - 名称 (右侧灰色小字为 Bot ID)
 * - 运行状态 + 运行时长 (运行中每秒本地递增, 不额外请求后端), 同一行右侧为启停按钮
 * - 适配器数量与列表 (未启用的适配器一并列出, 用弱化样式区分)
 * - 已装载的普通插件数 / 普通插件总数
 * - 基础信息: Bot 目录、本次启动时间
 *
 * 数据来源:
 * - `bot/get` 提供实时运行态、`runningTime`、目录与启动时间; 卡片上的 bot
 *   对象可能已经过时, 因此不直接复用它的 running。
 * - `bot/plugin/scan` 与插件页同语义 (先扫盘再回传): 未运行、从未扫描过的 Bot
 *   也能看到磁盘上的适配器与插件, 而不是误报 0 个。
 *
 * 注意: 头部容器用 div 而不是 <header> —— 弹窗外壳的
 * `.dialog-window header { flex-direction: row }` 会命中弹窗内的任何 header,
 * 且优先级高于单个类选择器, 会把"状态行"挤回名称那一行。
 */
import { callAPI } from "../../../spa/api.js"
import { createButton } from "../../../spa/components/button.js"
import { createIconButton } from "../../../spa/components/icon-button.js"
import { createError, createSpinner, STATUS_TEXT } from "../../../spa/components/plugin-card.js"
import toast from "../../../spa/toast.js"
import { formatUptime } from "../../home/format.js"

export default {
	icon: "/img/icons/info.svg",
	title: "信息",
	styles: ["/js/pages/bots/bot-pages/info.css"],

	/**
	 * @param {HTMLElement} div 面板内容容器
	 * @param {{ id: string, name?: string | null, running?: boolean }} bot
	 */
	render(div, bot) {
		div.replaceChildren()

		const page = document.createElement("div")
		page.className = "bot-info"

		// ---- 头部: 第一行名称 + ID, 第二行运行状态 + 时长 ----
		const head = document.createElement("div")
		head.className = "bot-info-head"

		const headline = document.createElement("div")
		headline.className = "bot-info-headline"

		const name = document.createElement("h2")
		name.className = "bot-info-name"
		name.textContent = bot.name || bot.id

		const id = document.createElement("code")
		id.className = "bot-info-id"
		id.textContent = bot.id
		id.title = `Bot ID: ${bot.id}`

		const refresh = createIconButton("/img/icons/refresh.svg", () => void load(true))
		refresh.classList.add("bot-page-refresh", "bot-info-refresh")
		refresh.title = "刷新 Bot 信息"
		refresh.setAttribute("aria-label", "刷新 Bot 信息")

		headline.append(name, id, refresh)

		const runtime = document.createElement("div")
		runtime.className = "bot-info-runtime"

		const state = document.createElement("span")
		state.className = "bot-info-state"

		const dot = document.createElement("span")
		dot.className = "dot off"

		const stateText = document.createElement("span")
		stateText.textContent = "加载中…"

		state.append(dot, stateText)

		/** 期望态与运行态不一致时的提示; 一致时留空 */
		const hint = document.createElement("span")
		hint.className = "bot-info-hint"
		hint.hidden = true

		const uptime = document.createElement("span")
		uptime.className = "bot-info-uptime"

		const uptimeLabel = document.createElement("span")
		uptimeLabel.className = "bot-info-uptime-label"
		uptimeLabel.textContent = "运行时长"

		const uptimeValue = document.createElement("span")
		uptimeValue.className = "bot-info-uptime-value"
		uptimeValue.textContent = "—"

		uptime.append(uptimeLabel, uptimeValue)

		// ---- 启停按钮: 置于第二行最右, 不单独占一行 ----
		const toggleBtn = createButton("加载中…", () => toggleState())
		toggleBtn.classList.add("bot-info-toggle")
		toggleBtn.disabled = true

		runtime.append(state, hint, uptime, toggleBtn)
		head.append(headline, runtime)

		// ---- 统计区 (加载中 / 出错时整体替换) ----
		const body = document.createElement("div")
		body.className = "bot-info-body"
		body.append(createSpinner())

		// ---- 基础信息: 目录 / 启动时间 ----
		const meta = document.createElement("div")
		meta.className = "card bot-info-meta"

		const pathValue = createMetaRow(meta, "Bot 目录")
		const startedValue = createMetaRow(meta, "启动时间")
		pathValue.textContent = "—"
		startedValue.textContent = "—"

		page.append(head, body, meta)
		div.append(page)

		/** 运行时长基准: 服务端快照 + 本地经过的时间 */
		let uptimeBase = null
		/** 每秒刷新运行时长的计时器 */
		let timer = null
		/** 最近一次已知的运行态, 供启停按钮判断点击方向 */
		let currentRunning = false
		/** 最近一次快照, 刷新时用于重画 */
		let latest = null

		/** 用最新快照重画运行状态、时长与启停按钮 */
		function paintRuntime(info) {
			latest = info
			const running = info.running === true
			const expected = info.state?.enable === true
			currentRunning = running

			state.classList.toggle("is-running", running)
			dot.className = `dot ${running ? "on" : "off"}`
			stateText.textContent = running ? "运行中" : "已停止"

			// 运行态与期望态对不上: 说明收敛尚未完成或失败, 明确说出来
			if (running !== expected) {
				hint.hidden = false
				hint.textContent = expected ? "期望启用, 尚未收敛" : "期望停用, 尚未收敛"
			} else {
				hint.hidden = true
			}

			if (info.name) name.textContent = info.name

			// 启停按钮: 运行中给"停止", 已停止给"启动"
			toggleBtn.textContent = running ? "停止 Bot" : "启动 Bot"
			toggleBtn.classList.toggle("primary", !running)
			toggleBtn.classList.toggle("danger", running)
			toggleBtn.disabled = false

			// 基础信息
			pathValue.textContent = info.path || "—"
			pathValue.title = info.path || ""
			startedValue.textContent = Number.isFinite(info.startedAt)
				? formatDateTime(info.startedAt)
				: "—"
			// 启动时间悬停给出精确到秒的完整时间
			startedValue.title = Number.isFinite(info.startedAt)
				? new Date(info.startedAt).toLocaleString()
				: "Bot 未运行"

			clearInterval(timer)
			timer = null

			if (running && Number.isFinite(info.runningTime)) {
				uptimeBase = { ms: info.runningTime, at: Date.now() }
				paintUptime()

				timer = setInterval(() => {
					// 面板被替换 / 弹窗关闭后容器会脱离文档, 计时器自行收尾
					if (!div.isConnected) {
						clearInterval(timer)
						timer = null
						return
					}
					paintUptime()
				}, 1000)
			} else {
				uptimeBase = null
				uptimeValue.textContent = running ? "—" : "未运行"
			}
		}

		function paintUptime() {
			if (!uptimeBase) return
			const elapsed = uptimeBase.ms + (Date.now() - uptimeBase.at)
			uptimeValue.textContent = formatUptime(elapsed / 1000)
		}

		/** 用插件扫描结果重画适配器与普通插件统计 */
		function paintPlugins(payload) {
			const groups = payload?.plugins ?? {}
			const all = [...(groups.global ?? []), ...(groups.bot ?? [])]

			const adapters = all.filter((item) => item.type === "adapter")
			const normals = all.filter((item) => item.type === "normal")
			const loadedNormals = normals.filter((item) => item.status === "enabled").length

			body.replaceChildren(createStats(adapters, loadedNormals, normals.length))
		}

		/** 启停按钮: 启动 / 停止后重新拉取, 让运行态、时长与插件统计一起对齐 */
		async function toggleState() {
			const target = !currentRunning
			toggleBtn.disabled = true

			try {
				const res = await callAPI("bot/state/update", { bot: bot.id, state: target })
				const actual = res?.state === true
				toast(`${name.textContent} ${actual ? "已启动" : "已停止"}`)
				await load(true)
			} catch (e) {
				toast(`切换 Bot 状态失败: ${e.message}`, { type: "error", duration: 5000 })
				toggleBtn.disabled = false
			}
		}

		/**
		 * 读取一次信息
		 * @param {boolean} [fromClick] 是否由刷新按钮触发
		 */
		async function load(fromClick) {
			refresh.classList.add("loading")
			if (!fromClick) body.replaceChildren(createSpinner())
			toggleBtn.disabled = true

			const [infoRes, pluginsRes] = await Promise.allSettled([
				callAPI("bot/get", { bot: bot.id }),
				callAPI("bot/plugin/scan", { bot: bot.id }),
			])

			refresh.classList.remove("loading")

			if (infoRes.status === "rejected") {
				const message = `加载 Bot 信息失败: ${infoRes.reason?.message ?? infoRes.reason}`
				body.replaceChildren(createError(message))
				stateText.textContent = "未知"
				state.classList.remove("is-running")
				dot.className = "dot off"
				hint.hidden = true
				clearInterval(timer)
				timer = null
				uptimeValue.textContent = "—"
				toggleBtn.textContent = "不可用"
				toggleBtn.disabled = true
				return
			}

			paintRuntime(infoRes.value)

			if (pluginsRes.status === "rejected") {
				const message = `加载插件列表失败: ${pluginsRes.reason?.message ?? pluginsRes.reason}`
				body.replaceChildren(createError(message))
				return
			}

			paintPlugins(pluginsRes.value)
		}

		void load(false)

		// 切页 / 关窗时立刻停表 (isConnected 自检只是兜底)
		return () => {
			clearInterval(timer)
			timer = null
		}
	},
}

/**
 * 基础信息里的一行: 左侧固定标签, 右侧值
 * @param {HTMLElement} container
 * @param {string} label
 * @returns {HTMLElement} 值节点 (由调用方填充)
 */
function createMetaRow(container, label) {
	const row = document.createElement("div")
	row.className = "bot-info-kv"

	const key = document.createElement("span")
	key.className = "bot-info-kv-key"
	key.textContent = label

	const value = document.createElement("span")
	value.className = "bot-info-kv-value"
	value.textContent = "—"

	row.append(key, value)
	container.append(row)
	return value
}

/** 时间戳 → "YYYY-MM-DD HH:mm:ss" (本地时区) */
function formatDateTime(ts) {
	const d = new Date(ts)
	if (Number.isNaN(d.getTime())) return "—"
	const pad = (n) => String(n).padStart(2, "0")
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
		+ `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 组装两张统计卡片: 左适配器, 右普通插件
 * @param {object[]} adapters 适配器视图数据
 * @param {number} loadedNormals 已装载的普通插件数
 * @param {number} totalNormals 普通插件总数
 * @returns {HTMLElement}
 */
function createStats(adapters, loadedNormals, totalNormals) {
	const grid = document.createElement("div")
	grid.className = "bot-info-stats"

	const adapterCard = createStatCard({
		icon: "/img/icons/adapter.svg",
		label: "适配器",
		count: `${adapters.length} 个`,
	})
	adapterCard.append(createAdapterBody(adapters))

	const pluginCard = createStatCard({
		icon: "/img/icons/cube.svg",
		label: "普通插件",
		count: totalNormals > 0 ? `共 ${totalNormals} 个` : "",
	})
	pluginCard.append(createPluginBody(loadedNormals, totalNormals))

	grid.append(adapterCard, pluginCard)
	return grid
}

/**
 * 统计卡片外壳: 标题行 (图标 + 名称 + 右侧计数)
 * @param {{ icon: string, label: string, count: string }} opts
 * @returns {HTMLElement}
 */
function createStatCard({ icon, label, count }) {
	const card = document.createElement("div")
	card.className = "card bot-stat"

	const head = document.createElement("div")
	head.className = "bot-stat-head"

	const iconEl = document.createElement("span")
	iconEl.className = "icon bot-stat-icon"
	iconEl.setAttribute("aria-hidden", "true")
	iconEl.style.setProperty("--icon", `url("${icon}")`)

	const title = document.createElement("span")
	title.className = "bot-stat-title"
	title.textContent = label

	const countEl = document.createElement("span")
	countEl.className = "bot-stat-count"
	countEl.textContent = count

	head.append(iconEl, title, countEl)
	card.append(head)
	return card
}

/** 适配器列表: 每个适配器一枚胶囊, 未启用的弱化显示 */
function createAdapterBody(adapters) {
	if (adapters.length === 0) {
		const empty = document.createElement("p")
		empty.className = "muted bot-stat-empty"
		empty.textContent = "未发现适配器"
		return empty
	}

	const list = document.createElement("ul")
	list.className = "bot-adapter-list"

	for (const item of adapters) {
		const li = document.createElement("li")
		li.className = item.status === "enabled" ? "bot-adapter-chip" : "bot-adapter-chip is-disabled"
		li.title = `${item.id} · ${STATUS_TEXT[item.status] ?? item.status}`

		const chipDot = document.createElement("span")
		chipDot.className = `dot ${item.status === "enabled" ? "on" : "off"}`

		const text = document.createElement("span")
		text.textContent = item.name || item.id

		li.append(chipDot, text)
		list.append(li)
	}

	return list
}

/** 普通插件: 主数值为已装载数, 右侧补总数与说明 */
function createPluginBody(loaded, total) {
	const wrap = document.createElement("div")
	wrap.className = "bot-stat-body"

	const value = document.createElement("div")
	value.className = "bot-stat-value"

	const main = document.createElement("span")
	main.className = "num"
	main.textContent = `${loaded}`

	const unit = document.createElement("span")
	unit.className = "bot-stat-unit"
	unit.textContent = total > 0 ? `/ ${total} 个` : "个"

	value.append(main, unit)

	const sub = document.createElement("div")
	sub.className = "bot-stat-sub"
	sub.textContent = total === 0
		? "未发现普通插件"
		: `已装载 ${loaded} 个 · 未启用 ${total - loaded} 个`

	wrap.append(value, sub)
	return wrap
}
