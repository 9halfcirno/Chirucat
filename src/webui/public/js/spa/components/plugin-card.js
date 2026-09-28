/**
 * 插件卡片: 各处插件列表共用的展示与交互单元
 *
 * 覆盖三件事, 但都只负责"界面", 不碰任何后端调用 —— 接口路径与请求体因宿主
 * 而异(Bot 插件按 bot 隔离, 服务插件全局一份), 由调用方通过回调注入:
 *
 * - 卡片: 名称 / 操作 / id·作者·版本 / 类型标识 / 运行状态 / 描述
 * - 分组: 可折叠的标题行 + 卡片网格
 * - 配置弹窗: 先加载定义与当前值, 再用 config-editor 渲染并保存
 *
 * 运行状态只有"开 / 关 / 切换中"一种口径: 状态文本与开关都由它推导, 不引入
 * 期望态之类的前端概念。
 */
import { apiFetch } from "../auth.js"
import { createConfigList } from "./config-editor.js"
import { createDialogWindow } from "./dialog-window.js"
import { createDotSwitch } from "./dot-switch.js"
import { createIconButton } from "./icon-button.js"
import toast from "../toast.js"

/** 插件运行状态 -> 展示文案 (只有运行态: 开 / 关 / 切换中) */
export const STATUS_TEXT = {
	enabled: "已启用",
	loading: "加载中",
	unloading: "卸载中",
	disabled: "已停用",
}

/** 切换中的状态: 此时不允许再次点开关 */
const BUSY_STATUS = ["loading", "unloading"]

/** 类型标识: 文案 + 图标 (着色由 CSS 按 plugin-card-type[data-type] 决定) */
const TYPE_META = {
	adapter: { label: "适配器", icon: "/img/icons/adapter.svg" },
	service: { label: "服务插件", icon: "/img/icons/plugin.svg" },
	normal: { label: "普通插件", icon: "/img/icons/cube.svg" },
}

/** 排序权重: 适配器最前, 服务插件次之, 普通插件最后 */
const TYPE_ORDER = { adapter: 0, service: 1, normal: 2 }

/** 统一的 POST JSON: 非 2xx 时抛出后端返回的错误文案 */
export async function postJSON(url, payload) {
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
export function createSpinner() {
	const spinner = document.createElement("div")
	spinner.className = "bot-page-loading"
	spinner.setAttribute("role", "status")
	spinner.setAttribute("aria-label", "加载中")
	return spinner
}

/** 加载失败提示 */
export function createError(message) {
	const el = document.createElement("p")
	el.className = "page-error"
	el.textContent = message
	return el
}

/**
 * 一组插件: 可折叠的标题行 + 卡片网格
 *
 * @param {string} label 分组标题
 * @param {object[]} items 插件视图数据
 * @param {object} opts 透传给 createPluginCard 的选项
 * @returns {HTMLElement}
 */
export function createPluginSection(label, items, opts) {
	// Array.prototype.sort 是稳定的: 同类型内保持接口返回的顺序
	const sorted = [...items].sort(
		(a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
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
		for (const item of sorted) grid.append(createPluginCard(item, opts))
		body.append(grid)
	}

	section.append(body)
	return section
}

/**
 * 单个插件卡片
 *
 * @param {object} item 插件视图数据
 *   (id / name / version / author / description / type / hasConfig / status)
 * @param {object} opts
 * @param {boolean} opts.toggleable 开关是否可用(如 Bot 未运行时置灰)
 * @param {string} [opts.toggleHint] 开关不可用时的提示文案
 * @param {(item: object, target: boolean) => Promise<boolean>|boolean} opts.onToggle
 *   点击开关的回调, 收到卡片数据与目标状态, 返回实际生效的状态; 抛错则提示并回弹
 * @param {(item: object) => void} [opts.onConfig] 点击配置按钮的回调(打开配置弹窗)
 * @returns {HTMLElement}
 */
export function createPluginCard(item, opts) {
	// 卡片自己维护运行状态: onToggle 成功后就地更新徽章与开关, 不必整页重绘
	let status = item.status

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
		if (item.hasConfig) opts.onConfig?.(item)
		else toast(`${item.type === "service" ? "服务插件" : "插件"} ${item.name || item.id} 没有可配置项`)
	})
	configBtn.disabled = !item.hasConfig
	configBtn.classList.add("plugin-card-config")
	configBtn.title = "修改插件配置"
	configBtn.setAttribute("aria-label", "修改插件配置")
	cardHead.append(configBtn)

	// 运行状态文本: 显示在开关左侧。需在 toggle 里被引用, 故先创建
	const statusEl = document.createElement("span")
	statusEl.className = "plugin-card-status"
	paintStatus(statusEl, status)
	cardHead.append(statusEl)

	/**
	 * 开关回调: 返回实际生效的运行态, 失败则回到原状态
	 * @param {PointerEvent} _ 事件(未使用)
	 * @param {boolean} target 目标状态
	 */
	async function toggle(_, target) {
		try {
			const next = await opts.onToggle(item, target)
			status = next === true ? "enabled" : "disabled"
			paintStatus(statusEl, status)
			paintSwitch(swh, status, opts.toggleable, opts.toggleHint)
			return status === "enabled"
		} catch (e) {
			// 请求被拒(插件起不来/未注册等): 运行态没变, 开关回到原处
			toast(`切换插件状态失败: ${e.message}`, { type: "error", duration: 5000 })
			return status === "enabled"
		}
	}

	const swh = createDotSwitch(toggle, status === "enabled")
	swh.classList.add("plugin-card-switch")
	paintSwitch(swh, status, opts.toggleable, opts.toggleHint)
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

	const typeMeta = TYPE_META[item.type] ?? TYPE_META.normal
	const type = document.createElement("span")
	type.className = "plugin-card-type"
	type.dataset.type = TYPE_META[item.type] ? item.type : "normal"

	const typeIcon = document.createElement("span")
	typeIcon.className = "icon"
	typeIcon.style.setProperty("--icon", `url("${typeMeta.icon}")`)
	type.append(typeIcon, document.createTextNode(typeMeta.label))

	kind.append(type)

	// ---- 描述 ----
	const desc = document.createElement("p")
	desc.className = "plugin-card-desc"
	desc.textContent = item.description || "无描述"

	card.append(cardHead, meta, kind, desc)
	return card
}

/**
 * 插件配置弹窗: 先读定义与当前值, 再用 config-editor 渲染
 *
 * @param {object} opts
 * @param {string} opts.title 弹窗标题
 * @param {() => Promise<{ define: unknown, config: unknown }>} opts.load 读取配置
 * @param {(values: unknown) => Promise<{ config?: unknown }>} opts.save 保存配置
 * @param {string} [opts.label] 提示与标题里使用的插件称谓(默认"插件")
 * @returns {Promise<void>} 弹窗关闭后 resolve
 */
export async function openConfigDialog(opts) {
	const inner = document.createElement("div")
	inner.className = "plugin-config"

	const slot = document.createElement("div")
	slot.append(createSpinner())
	inner.append(slot)

	/** 配置表单控制器; 读取完成前为 null, 此时点"保存"不做事 */
	let list = null

	const dialog = createDialogWindow(opts.title, inner, [
		{ name: "保存", onclick: () => save() },
		{ name: "取消", onclick: () => dialog.closeDialog() },
	], { cancelable: true, maximize: true })
	document.body.append(dialog)

	try {
		const data = await opts.load()
		list = createConfigList(data.define)
		list.setValues(data.config)
		slot.replaceChildren(list.el)
	} catch (e) {
		slot.replaceChildren(createError(`读取配置失败: ${e.message}`))
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
			const data = await opts.save(list.getValues())
			// 回传的是补齐隐藏项后的规范值, 用它把表单对齐到落盘内容
			if (data.config) list.setValues(data.config)
			toast(`${opts.label ?? "插件"}配置已保存`)
			dialog.closeDialog()
		} catch (e) {
			toast(`保存配置失败: ${e.message}`, { type: "error", duration: 5000 })
		}
	}
}

/**
 * 把运行状态写到徽章上 (着色由 CSS 按 data-status 决定)
 *
 * 只有运行态一种口径: 开着就是启用, 加载失败就是没跑起来(已停用),
 * 不再根据期望态另立"未加载"这类说法。
 */
export function paintStatus(el, status) {
	el.dataset.status = status
	el.textContent = STATUS_TEXT[status] ?? status
}

/**
 * 按运行态与可用性决定开关状态, 并给出对应提示
 * @param {HTMLButtonElement} swh 开关
 * @param {string} status 运行状态
 * @param {boolean} toggleable 是否允许启停
 * @param {string} [hint] 不允许时的原因
 */
export function paintSwitch(swh, status, toggleable, hint) {
	const busy = BUSY_STATUS.includes(status)
	swh.disabled = !toggleable || busy

	const label = !toggleable
		? (hint || "当前无法启停插件")
		: busy
			? "正在切换状态, 请稍候"
			: status === "enabled" ? "点击停用" : "点击启用"

	swh.title = label
	swh.setAttribute("aria-label", label)
}
