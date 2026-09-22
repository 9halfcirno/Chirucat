import { apiFetch } from "../../../spa/auth.js"
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
	render(div, bot) {

		let configList = createConfigList(createConfig(bot));
		div.append(configList.el);



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
			{ name: "确定", onclick: handleConfirm },
			{ name: "取消", onclick: () => ensure.closeDialog() }
		],
		true
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


function createConfig(bot) {
	return {
		controls: [
			{
				type: "input",
				id: "id",
				label: "Bot ID",
				default: bot.id,
				desc: "Bot的标识, 更改可能导致部分数据出现异常",
				required: true
			},
			{
				type: "input",
				id: "name",
				label: "Bot 名称",
				default: bot.name
			},

		]
	}
}