/**
 * Bot 设置页
 *
 * 定义与值都来自后端 (`get_bot_config`) —— 前端不持有设置项定义。此前这里
 * 硬编码了 id/name 两个输入框, 后端改了没人知道, 也正是"设置页只能看不能存"的根源。
 */
import { callAPI } from "../../../spa/api.js"
import { apiFetch } from "../../../spa/auth.js"
import { createButton } from "../../../spa/components/button.js"
import { createConfigList } from "../../../spa/components/config-editor.js"
import { createDialogWindow } from "../../../spa/components/dialog-window.js"
import { createIconButton } from "../../../spa/components/icon-button.js"
import toast from "../../../spa/toast.js"

export default {
	icon: "/img/icons/setting.svg",
	title: "设置",

	/**
	 * @param {HTMLElement} div
	 * @param {{ id: string, state?: boolean }} bot
	 */
	async render(div, bot) {
		const status = document.createElement("p")
		status.className = "muted"
		status.textContent = "加载中..."
		div.append(status)

		let payload
		try {
			payload = await callAPI("get_bot_config", { id: bot.id })
		} catch (e) {
			status.textContent = `读取Bot设置失败: ${e.message}`
			return
		}
		status.remove()

		const list = createConfigList(payload.define)
		list.setValues(payload.values ?? {})

		const save = createButton("保存", () => handleSave(bot, list))
		div.append(list.el, save)

		// 删除bot相关
		const delDes = document.createElement("div")
		delDes.textContent = "删除Bot"
		delDes.style.color = "darkred"

		const delBtn = createIconButton("/img/icons/delete.svg", () => {
			handleDeleteClick(bot, div, delBtn)
		})
		delBtn.style.width = "2.75em"
		delBtn.style.height = "2.75em"

		div.append(delDes, delBtn)
	}
}

/**
 * 保存该 Bot 的设置
 *
 * 提交整份 getValues(): 后端按 patch 语义合并, 未提交的字段保留原值; id 是
 * immutable, 提交不同的值会被后端拒绝。
 *
 * @param {{ id: string }} bot
 * @param {ReturnType<typeof createConfigList>} list
 */
async function handleSave(bot, list) {
	const errors = list.validate()
	if (errors.length > 0) {
		toast(`有 ${errors.length} 项未填完整, 请先修正`, { type: "warn" })
		return
	}

	try {
		const result = await callAPI("update_bot_config", { id: bot.id, patch: list.getValues() })

		// 用后端回传的规范化值回填, 并让列表上的名称同步过来
		if (result?.values) list.setValues(result.values)
		toast("Bot 设置已保存", { type: "info" })
		document.body.querySelector(".bot-refresh-btn")?.click()
	} catch (e) {
		toast(`保存Bot设置失败: ${e.message}`, { type: "error" })
	}
}

/**
 * 点击删除: 先检查运行状态, 运行中则拒绝
 * @param {{ id: string }} bot
 * @param {HTMLElement} container
 * @param {HTMLElement} btn
 */
async function handleDeleteClick(bot, container, btn) {
	btn.disabled = true
	try {
		const running = await fetchBotRunning(bot.id)
		if (running) {
			toast(`Bot ${bot.id} 正在运行中, 请先停止后再删除`, { type: "warn" })
			return
		}
		showDeleteConfirm(bot, container)
	} catch (e) {
		toast(`获取Bot状态失败: ${e.message}`, { type: "error" })
	} finally {
		btn.disabled = false
	}
}

/**
 * 请求 bot 运行状态
 *
 * 必须读 running 而不是 state.enable: 后者只是持久化的期望态,
 * 文件里写着启用而实际没跑起来时, 用它会误判成"正在运行"。
 * @param {string} id
 * @returns {Promise<boolean>} 是否正在运行
 */
async function fetchBotRunning(id) {
	const res = await apiFetch("/api/get_bot_state", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id })
	})
	if (!res.ok) throw new Error(`HTTP: ${res.status}`)
	const data = await res.json()
	return data.running === true
}

/**
 * 弹出删除 Bot 的二次确认对话框
 * @param {{ id: string }} bot
 * @param {HTMLElement} container 设置面板容器, 用于定位父级对话框
 */
function showDeleteConfirm(bot, container) {
	const { content, input } = buildConfirmContent(bot.id)

	const ensure = createDialogWindow(
		"删除Bot确认?",
		content,
		[
			{ name: "确定", onclick: handleConfirm, danger: true },
			{ name: "取消", onclick: () => ensure.closeDialog() }
		],
		{ cancelable: true }
	)

	async function handleConfirm() {
		if (input.value.trim() !== bot.id) {
			input.focus()
			input.select?.()
			toast("Bot ID 输入不正确, 已阻止删除", { type: "warn" })
			return
		}
		ensure.closeDialog()
		await deleteBot(bot, container)
	}

	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault()
			handleConfirm()
		}
	})

	document.body.append(ensure)
	requestAnimationFrame(() => input.focus())
}

/**
 * 构建确认对话框的内容 (纯 DOM, 避免 XSS 风险)
 * @param {string} botId
 * @returns {{ content: HTMLElement, input: HTMLInputElement }}
 */
function buildConfirmContent(botId) {
	const content = document.createElement("div")

	const intro = document.createElement("div")
	intro.append("确定删除 Bot ")
	const idStrong = document.createElement("strong")
	idStrong.textContent = botId
	intro.append(idStrong, "? 此操作无法撤销!")

	const detail = document.createElement("div")
	detail.style.marginTop = "0.75em"
	detail.append("将删除的数据包括:")
	const ul = document.createElement("ul")
	ul.style.margin = "0.25em 0 0 1.25em"
	ul.style.padding = "0"
	for (const text of [
		"Bot配置, 状态文件, 数据文件",
		"Bot独立插件, 插件配置, 插件数据"
	]) {
		const li = document.createElement("li")
		li.textContent = text
		ul.append(li)
	}
	detail.append(ul)

	const warn = document.createElement("div")
	warn.style.marginTop = "0.75em"
	const warnStrong = document.createElement("strong")
	warnStrong.textContent = "请认真考虑!"
	warn.append(warnStrong)

	const tip = document.createElement("div")
	tip.style.marginTop = "1em"
	tip.textContent = `请输入 Bot ID "${botId}" 以确认删除:`

	const input = document.createElement("input")
	input.className = "input"
	input.type = "text"
	input.autocomplete = "off"
	input.spellcheck = false
	input.placeholder = botId
	input.style.marginTop = "0.5em"

	content.append(intro, detail, warn, tip, input)
	return { content, input }
}

/**
 * 执行删除请求
 * @param {{ id: string }} bot
 * @param {HTMLElement} container
 */
async function deleteBot(bot, container) {
	try {
		const res = await apiFetch("/api/delete_bot", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: bot.id })
		})
		if (!res.ok) throw new Error(`HTTP: ${res.status}`)

		toast(`删除Bot ${bot.id}成功!`, { type: "info" })

		const base = container.closest(".dialog-window-base")
		base?.closeDialog?.()

		document.body.querySelector(".bot-refresh-btn")?.click()
	} catch (e) {
		toast(`删除Bot失败: ${e.message}`, { type: "error" })
	}
}
