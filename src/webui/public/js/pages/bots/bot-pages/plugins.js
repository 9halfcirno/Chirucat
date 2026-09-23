/**
 * Bot 面板 · 插件管理页
 *
 * 提供四件事:
 * - 列表: 全局插件 / Bot 私有插件分组展示, 带类型、版本与运行状态
 * - 启停: 单个插件开关, 走 set_plugin_state (先收敛运行态, 成功才落盘)
 * - 刷新: 重新扫描插件目录, 与 scan_bots 同语义(先扫描再回传列表)
 * - 配置: 声明了配置的插件给出入口, 弹窗内用 config-editor 渲染并保存
 *
 * 未运行的 Bot 也能扫出插件列表, 但插件只能在 Bot 运行时加载, 因此此时
 * 顶部给出提示, 且所有开关置为 disabled。
 */
import { apiFetch } from "../../../spa/auth.js"
import { createConfigList } from "../../../spa/components/config-editor.js"
import { createDialogWindow } from "../../../spa/components/dialog-window.js"
import { createDotSwitch } from "../../../spa/components/dot-switch.js"
import { createIconButton } from "../../../spa/components/icon-button.js"
import toast from "../../../spa/toast.js"

/** 插件运行状态 -> 展示文案 (只有运行态: 开 / 关 / 切换中) */
const STATUS_TEXT = {
	enabled: "已启用",
	loading: "加载中",
	unloading: "卸载中",
	disabled: "已停用",
}

/** 切换中的状态: 此时不允许再次点开关 */
const BUSY_STATUS = ["loading", "unloading"]

export default {
	icon: "/img/icons/plugin.svg",
	title: "插件",

	/**
	 * @param {HTMLElement} div 面板内容容器
	 * @param {{ id: string, name?: string | null }} bot
	 */
	render(div, bot) {
		div.replaceChildren()

		const head = document.createElement("div")
		head.className = "bot-page-head"

		const title = document.createElement("h3")
		title.className = "bot-page-title"
		title.textContent = `${bot.name || bot.id} 的插件`
		head.append(title)

		const refresh = createIconButton("/img/icons/refresh.svg", () => reload(true))
		refresh.classList.add("bot-page-refresh")
		refresh.title = "刷新插件列表"
		refresh.setAttribute("aria-label", "刷新插件列表")
		head.append(refresh)

		/** Bot 未运行时的提示条; 运行时隐藏 */
		const tip = document.createElement("p")
		tip.className = "plugin-page-tip"
		tip.hidden = true

		const body = document.createElement("div")
		body.className = "plugin-page-body"

		div.append(head, tip, body)

		let firstLoad = true

		// 首屏与"刷新"共用同一个接口: 先扫描目录再回传, 因此未启动的 Bot
		// 也能看到一个和磁盘对齐的列表(这些插件都是"关着"的状态)
		async function reload(fromClick) {
			refresh.classList.add("loading")
			if (firstLoad) body.replaceChildren(createSpinner())

			try {
				const data = await postJSON("/api/refresh_plugins", { bot: bot.id })
				paint(data)
				if (fromClick) toast("插件列表已刷新")
			} catch (e) {
				const message = `加载插件列表失败: ${e.message}`
				body.replaceChildren(createError(message))
				if (fromClick) toast(message, { type: "error", duration: 5000 })
			} finally {
				firstLoad = false
				refresh.classList.remove("loading")
			}
		}

		/** 按接口返回渲染: 顶部提示 + 两组插件 */
		function paint(data) {
			const running = data.running === true
			const groups = data.plugins ?? {}

			tip.hidden = running
			if (!running) {
				tip.textContent = `Bot ${bot.name || bot.id} 未运行: 插件只能随 Bot 启动加载, 当前无法启停。`
			}

			body.replaceChildren(
				createSection("全局插件", groups.global ?? [], running),
				createSection("Bot 私有插件", groups.bot ?? [], running),
			)
		}

		/** 一组插件: 可折叠的标题行 + 卡片网格 */
		function createSection(label, list, running) {
			// 适配器插件排在最前, 便于从一堆普通插件里区分出来
			// (Array.prototype.sort 是稳定的, 同类型内保持接口返回的顺序)
			const sorted = [...list].sort(
				(a, b) => (a.type === "adapter" ? 0 : 1) - (b.type === "adapter" ? 0 : 1)
			)

			const section = document.createElement("section")
			section.className = "plugin-group"

			// 标题行本身就是折叠开关
			const head = document.createElement("button")
			head.type = "button"
			head.className = "plugin-group-head"
			head.setAttribute("aria-expanded", "true")

			const caret = document.createElement("span")
			caret.className = "plugin-group-caret"

			const heading = document.createElement("h4")
			heading.className = "plugin-group-title"
			heading.textContent = `${label} (${sorted.length})`

			head.append(caret, heading)
			section.append(head)

			head.addEventListener("click", () => {
				const collapsed = section.classList.toggle("collapsed")
				head.setAttribute("aria-expanded", String(!collapsed))
			})

			const body = document.createElement("div")
			body.className = "plugin-group-body"

			if (sorted.length === 0) {
				const empty = document.createElement("p")
				empty.className = "muted"
				empty.textContent = "暂无插件"
				body.append(empty)
			} else {
				const grid = document.createElement("div")
				grid.className = "plugin-grid"
				for (const item of sorted) grid.append(createCard(item, running))
				body.append(grid)
			}

			section.append(body)
			return section
		}

		/** 单个插件卡片: 名称与操作 / id·作者·版本 / 类型标识 / 描述 */
		function createCard(item, running) {
			const card = document.createElement("div")
			card.className = "card plugin-card"

			// ---- 头部: 名称在左, 配置入口与启停开关在右 ----
			const cardHead = document.createElement("div")
			cardHead.className = "plugin-card-head"

			const name = document.createElement("div")
			name.className = "plugin-card-name"
			name.textContent = item.name || item.id
			name.title = item.id
			cardHead.append(name)

			// 只有声明了配置定义的插件才给出配置入口
			const configBtn = createIconButton("/img/icons/setting.svg", () => {
				if (item.hasConfig) openConfigDialog(item);
				else toast(`插件 ${item.name || item.id} 没有可配置项`)
			})
			configBtn.classList.add("plugin-card-config")
			configBtn.title = "修改插件配置"
			configBtn.setAttribute("aria-label", "修改插件配置")
			cardHead.append(configBtn)

			// 运行状态文本: 显示在开关左侧。需在 toggle 里被引用, 故先创建
			const statusEl = document.createElement("span")
			statusEl.className = "plugin-card-status"
			paintStatus(statusEl, item)
			cardHead.append(statusEl)

			/**
			 * 开关回调: 返回实际生效的运行态, 失败则回到原状态
			 * @param {PointerEvent} _ 事件(未使用)
			 * @param {boolean} target 目标状态
			 */
			async function toggle(_, target) {
				try {
					const data = await postJSON("/api/set_plugin_state", {
						bot: bot.id,
						id: item.id,
						state: target,
					})
					const state = data.state === true
					item.status = state ? "enabled" : "disabled"
					paintStatus(statusEl, item)
					paintSwitch(swh, item.status, running)
					toast(`插件 ${item.name || item.id} ${state ? "已启用" : "已停用"}`)
					return state
				} catch (e) {
					// 请求被拒(插件起不来/未注册等): 运行态没变, 开关回到原处
					toast(`切换插件状态失败: ${e.message}`, { type: "error", duration: 5000 })
					return item.status === "enabled"
				}
			}

			const swh = createDotSwitch(toggle, item.status === "enabled")
			swh.classList.add("plugin-card-switch")
			paintSwitch(swh, item.status, running)
			cardHead.append(swh)

			// ---- 第一行: id + 作者 + 版本 ----
			const meta = document.createElement("div")
			meta.className = "plugin-card-meta"

			const id = document.createElement("code")
			id.className = "plugin-card-id"
			id.textContent = item.id

			const author = document.createElement("span")
			author.className = "plugin-card-author"
			author.textContent = item.author || "未知作者"

			const version = document.createElement("span")
			version.className = "plugin-card-version"
			version.textContent = `v${item.version}`

			meta.append(id, author, version)

			// ---- 第二行: 类型标识 (图标 + 文案, 按类型着色) ----
			const kind = document.createElement("div")
			kind.className = "plugin-card-kind"

			const isAdapter = item.type === "adapter"
			const type = document.createElement("span")
			type.className = "plugin-card-type"
			type.dataset.type = isAdapter ? "adapter" : "normal"

			const typeIcon = document.createElement("span")
			typeIcon.className = "icon"
			typeIcon.style.setProperty("--icon", `url("${isAdapter ? "/img/icons/adapter.svg" : "/img/icons/cube.svg"}")`)
			type.append(typeIcon, document.createTextNode(isAdapter ? "适配器" : "普通插件"))

			kind.append(type)

			// ---- 描述 ----
			const desc = document.createElement("p")
			desc.className = "plugin-card-desc"
			desc.textContent = item.description || "无描述"

			card.append(cardHead, meta, kind, desc)
			return card
		}

		/** 插件配置弹窗: 先读定义与当前值, 再用 config-editor 渲染 */
		async function openConfigDialog(item) {
			const inner = document.createElement("div")
			inner.className = "plugin-config"

			// const sub = document.createElement("p")
			// sub.className = "plugin-config-sub"
			// sub.textContent = `${item.name || item.id} (${item.id}) 的配置`

			const slot = document.createElement("div")
			slot.append(createSpinner())
			inner.append(slot)

			/** 配置表单控制器; 读取完成前为 null, 此时点"保存"不做事 */
			let list = null

			const dialog = createDialogWindow(`${item.name}(${item.id})的插件配置`, inner, [
				{ name: "保存", onclick: () => save() },
				{ name: "取消", onclick: () => dialog.closeDialog() },
			], { cancelable: true, maximize: true })
			document.body.append(dialog)

			try {
				const data = await postJSON("/api/get_plugin_config", { bot: bot.id, id: item.id })
				list = createConfigList(data.define)
				list.setValues(data.config)
				slot.replaceChildren(list.el)
			} catch (e) {
				slot.replaceChildren(createError(`读取插件配置失败: ${e.message}`))
				return
			}

			/** 保存: 先本地校验, 再交给后端(后端也会校验并落盘) */
			async function save() {
				if (!list) return

				const errors = list.validate()
				if (errors.length > 0) {
					toast(`配置校验未通过: ${errors.map(error => error.message).join("; ")}`, {
						type: "warn",
						duration: 5000,
					})
					return
				}

				try {
					const data = await postJSON("/api/update_plugin_config", {
						bot: bot.id,
						id: item.id,
						config: list.getValues(),
					})
					// 回传的是补齐隐藏项后的规范值, 用它把表单对齐到落盘内容
					if (data.config) list.setValues(data.config)
					toast(`插件 ${item.name || item.id} 的配置已保存`)
					dialog.closeDialog()
				} catch (e) {
					toast(`保存插件配置失败: ${e.message}`, { type: "error", duration: 5000 })
				}
			}
		}

		void reload(false)
	}
}

/** 统一的 POST JSON: 非 2xx 时抛出后端返回的错误文案 */
async function postJSON(url, payload) {
	const res = await apiFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	})

	const data = await res.json().catch(() => null)
	if (!res.ok) throw new Error(data?.err || `HTTP ${res.status}`)
	return data ?? {}
}

/** 居中的加载指示 */
function createSpinner() {
	const spinner = document.createElement("div")
	spinner.className = "bot-page-loading"
	spinner.setAttribute("role", "status")
	spinner.setAttribute("aria-label", "加载中")
	return spinner
}

/** 加载失败提示 */
function createError(message) {
	const el = document.createElement("p")
	el.className = "page-error"
	el.textContent = message
	return el
}

/**
 * 把运行状态写到徽章上 (着色由 CSS 按 data-status 决定)
 *
 * 只有运行态一种口径: 开着就是启用, 加载失败就是没跑起来(已停用),
 * 不再根据期望态另立"未加载"这类说法。
 */
function paintStatus(el, item) {
	el.dataset.status = item.status
	el.textContent = STATUS_TEXT[item.status] ?? item.status
}

/** 按运行态与插件状态决定开关是否可用, 并给出对应提示 */
function paintSwitch(swh, status, running) {
	const busy = BUSY_STATUS.includes(status)
	// 只在 Bot 运行时才可能加载/卸载插件, 否则开关点了也会被后端拒绝
	swh.disabled = !running || busy

	const label = !running
		? "Bot 未运行, 无法启停插件"
		: busy
			? "插件正在切换状态, 请稍候"
			: status === "enabled" ? "点击停用" : "点击启用"

	swh.title = label
	swh.setAttribute("aria-label", label)
}
