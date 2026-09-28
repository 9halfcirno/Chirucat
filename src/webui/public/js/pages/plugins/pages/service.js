import { createError, createPluginSection, createSpinner, openConfigDialog, postJSON } from "../../../spa/components/plugin-card.js"
import { createIconButton } from "../../../spa/components/icon-button.js"
import toast from "../../../spa/toast.js"

/** 服务插件子页面: 列表 + 启停 + 配置 */
export function renderServices(div) {
	div.replaceChildren()

	const head = document.createElement("div")
	head.className = "bot-page-head"

	const title = document.createElement("h3")
	title.className = "bot-page-title"
	title.textContent = "服务插件"
	head.append(title)

	const refresh = createIconButton("/img/icons/refresh.svg", () => reload(true))
	refresh.classList.add("bot-page-refresh")
	refresh.title = "重新扫描 services/ 目录"
	refresh.setAttribute("aria-label", "刷新服务插件列表")
	head.append(refresh)

	const body = document.createElement("div")
	body.className = "plugin-page-body"

	div.append(head, body)

	let firstLoad = true

	// 首屏与"刷新"共用同一个接口: 先扫描 services/ 再回传, 列表始终和磁盘对齐
	async function reload(fromClick) {
		refresh.classList.add("loading")
		if (firstLoad) body.replaceChildren(createSpinner())

		try {
			const data = await postJSON("/api/refresh_services", {})
			paint(data)
			if (fromClick) toast("服务插件列表已刷新")

			// 扫描后会按期望态收敛; 起不来的排在 failed 里, 列表照常展示
			const failed = Array.isArray(data.failed) ? data.failed : []
			if (failed.length) {
				toast(`以下服务未能启用: ${failed.join(", ")} (原因见日志)`, { type: "warn", duration: 5000 })
			}
		} catch (e) {
			const message = `加载服务插件列表失败: ${e.message}`
			body.replaceChildren(createError(message))
			if (fromClick) toast(message, { type: "error", duration: 5000 })
		} finally {
			firstLoad = false
			refresh.classList.remove("loading")
		}
	}

	/** 只按接口返回渲染: 服务插件没有"未运行"这一说, 开关始终可用 */
	function paint(data) {
		body.replaceChildren(createPluginSection("服务插件", data.plugins ?? [], {
			toggleable: true,
			onToggle: toggleService,
			onConfig: openConfig,
		}))
	}

	/**
	 * 启停单个服务: 服务之间有依赖, 一次操作可能连带启用/停用多个 —— 接口
	 * 因此回传完整列表, 这里直接整块重绘, 免得个别卡片停在旧状态。
	 * @param {object} item 服务插件视图数据
	 * @param {boolean} target 目标状态
	 */
	async function toggleService(item, target) {
		let data
		try {
			data = await postJSON("/api/set_service_state", { id: item.id, state: target })
		} catch (e) {
			// 失败也可能已经改动了运行态(连带加载/卸载跑到一半), 拉一次列表把界面拉回
			// 现实, 再把错误抛给卡片去提示与回弹
			try {
				paint(await postJSON("/api/get_service_list", {}))
			} catch { /* 刷新失败就维持现状: 原始错误更要紧 */ }
			throw e
		}

		const state = data.state === true
		toast(`服务插件 ${item.name || item.id} ${state ? "已启用" : "已停用"}`)

		// 依赖连带: 停用会把依赖它的服务一并卸载, 启用会把它依赖的服务一并拉起
		const affected = Array.isArray(data.affected) ? data.affected : []
		if (affected.length) {
			toast(
				`受依赖连带影响, ${state ? "已一并启用" : "已一并停用"}: ${affected.join(", ")}`,
				{ duration: 5000 },
			)
		}

		paint(data)
		return state
	}

	/** 服务配置弹窗: 值文件全局唯一, 因此请求体只有 id */
	function openConfig(item) {
		void openConfigDialog({
			title: `${item.name}(${item.id})的服务配置`,
			label: "服务插件",
			load: () => postJSON("/api/get_service_config", { id: item.id }),
			save: (config) => postJSON("/api/update_service_config", { id: item.id, config }),
		})
	}

	void reload(false)
}
