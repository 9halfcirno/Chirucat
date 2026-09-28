/**
 * Bot 面板 · 插件管理页
 *
 * 提供四件事:
 * - 列表: 全局插件 / Bot 私有插件分组展示, 带类型、版本与运行状态
 * - 启停: 单个插件开关, 走 set_plugin_state (先收敛运行态, 成功才落盘)
 * - 刷新: 重新扫描插件目录, 与 scan_bots 同语义(先扫描再回传列表)
 * - 配置: 声明了配置的插件给出入口, 弹窗内用 config-editor 渲染并保存
 *
 * 卡片与配置弹窗的实现在 spa/components/plugin-card.js, 与 WebUI 的服务插件页
 * 共用; 这里只负责数据来源 —— 接口都带 bot 字段, 且开关只在 Bot 运行时可用。
 *
 * 未运行的 Bot 也能扫出插件列表, 但插件只能在 Bot 运行时加载, 因此此时
 * 顶部给出提示, 且所有开关置为 disabled。
 */
import { createError, createPluginSection, createSpinner, openConfigDialog, postJSON } from "../../../spa/components/plugin-card.js"
import { createIconButton } from "../../../spa/components/icon-button.js"
import toast from "../../../spa/toast.js"

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

			const opts = {
				// 插件只能在 Bot 运行时加载/卸载, 未运行时开关置灰并说明原因
				toggleable: running,
				toggleHint: `Bot ${bot.name || bot.id} 未运行, 无法启停插件`,
				onToggle: togglePlugin,
				onConfig: openConfig,
			}

			body.replaceChildren(
				createPluginSection("全局插件", groups.global ?? [], opts),
				createPluginSection("Bot 私有插件", groups.bot ?? [], opts),
			)
		}

		/**
		 * 启停单个插件: 回传收敛后的运行态, 失败由卡片提示并回弹
		 * @param {object} item 插件视图数据
		 * @param {boolean} target 目标状态
		 */
		async function togglePlugin(item, target) {
			const data = await postJSON("/api/set_plugin_state", {
				bot: bot.id,
				id: item.id,
				state: target,
			})
			const state = data.state === true
			toast(`插件 ${item.name || item.id} ${state ? "已启用" : "已停用"}`)
			return state
		}

		/** 插件配置弹窗: 配置值按 Bot 隔离 */
		function openConfig(item) {
			void openConfigDialog({
				title: `${item.name}(${item.id})的插件配置`,
				label: "插件",
				load: () => postJSON("/api/get_plugin_config", { bot: bot.id, id: item.id }),
				save: (config) => postJSON("/api/update_plugin_config", { bot: bot.id, id: item.id, config }),
			})
		}

		void reload(false)
	}
}
