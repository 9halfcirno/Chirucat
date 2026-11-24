/**
 * 首页: 仪表盘 (入口)
 *
 * 版式按 WEBUI_HOME.md 的字符画, 左右两列共六块:
 *   左列 (自适应)      右列 (~320px)
 *   ├ 机器人            ├ 系统资源 (CPU / 内存 两张环图)
 *   ├ Chirucat核心      └ 操作系统
 *   └ 进程信息
 * 各板块的 DOM 由 panels/ 下的工厂创建, 通用骨架在 widgets.js,
 * 环图在 ring.js, 数值格式化在 format.js。
 *
 * 数据源: /api/core/state/get, 每 5s 刷新一次。
 * 性能: 面板骨架只在首次成功时创建一次, 之后只改文本 / 环图比例 / 状态点
 * (增量更新), 不重建 DOM; bot 列表同样复用已有 <li>。
 *
 * 旧版顶部的「服务器 / 核心」状态条已去掉 —— 字符画里没有它的位置,
 * 而且这个接口活不活就是整页活不活: 拿不到数据时直接在网格上方留一条
 * 错误提示, 比一行永远显示"正常"的状态点更有意义。核心连接状态收敛到了
 * Chirucat核心 卡片的状态点里。
 */
import { createBotPanel } from "./panels/bot-panel.js";
import { createCorePanel } from "./panels/core-panel.js";
import { createProcessPanel } from "./panels/process-panel.js";
import { createResourcePanel } from "./panels/resource-panel.js";
import { createSystemPanel } from "./panels/system-panel.js";
import { apiFetch } from "../../spa/auth.js";

const REFRESH_TIME = 5_000;

let refreshTimer = null;
let uptimeTimer = null;

/** 停止两个定时器 (可重复调用) */
function stopTimers() {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
	if (uptimeTimer) {
		clearInterval(uptimeTimer);
		uptimeTimer = null;
	}
}

export default {
	id: "home",
	title: "首页",
	icon: "🏠",
	styles: ["/js/pages/home/home.css"],

	async render(container) {
		container.classList.add("home-page");

		// 防御: 极端情况下上一次渲染的定时器可能仍在, 先停掉, 避免重复刷新
		stopTimers();

		const grid = document.createElement("div");
		grid.className = "home-grid";

		const mainCol = document.createElement("div");
		mainCol.className = "home-main";

		const sideCol = document.createElement("div");
		sideCol.className = "home-side";

		const bot = createBotPanel();
		const core = createCorePanel();
		const proc = createProcessPanel();
		const resource = createResourcePanel();
		const system = createSystemPanel();
		const panels = [bot, core, proc, resource, system];

		mainCol.append(bot.element, core.element, proc.element);
		sideCol.append(resource.element, system.element);
		grid.append(mainCol, sideCol);
		container.append(grid);

		/** 运行时长的起算时刻 (ms): 连核心时是核心的 runningAt, 独立运行是进程启动时刻 */
		let uptimeBase = null;

		// 每秒按起算时刻重算 (用 Date.now 差值, 无累计误差, 也不等 5s 刷新);
		// 基准为 null (核心初始化中) 时不动文本, 维持 "已运行 —"
		const tickUptime = () => {
			if (uptimeBase == null) return;
			core.setUptime((Date.now() - uptimeBase) / 1000);
		};

		/** 错误提示节点: 只在失败时创建, 成功后移除, 不遮挡任何板块 */
		let errBox = null;
		const showError = (message) => {
			if (!errBox) {
				errBox = document.createElement("div");
				errBox.className = "page-error";
				container.prepend(errBox);
			}
			errBox.textContent = message;
		};
		const clearError = () => {
			errBox?.remove();
			errBox = null;
		};

		/** 在途标记: 上一轮还没回来时跳过本轮, 避免请求堆叠 */
		let inFlight = false;

		const refresh = async () => {
			if (inFlight) return;
			inFlight = true;
			try {
				const res = await apiFetch("/api/core/state/get");
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const state = await res.json();

				clearError();
				for (const panel of panels) panel.update(state);

				// 起算时刻由核心卡决定 (核心 runningAt / 进程 startTime / 初始化中为 null)
				uptimeBase = core.uptimeBase(state);
				tickUptime();
			} catch (err) {
				// 失败时不清空已有数据: 保留上一次的展示, 只在顶部提示
				showError(`获取运行状态失败: ${err.message}`);
			} finally {
				inFlight = false;
			}
		};

		await refresh();
		refreshTimer = setInterval(refresh, REFRESH_TIME);
		uptimeTimer = setInterval(tickUptime, 1_000);
	},

	destroy() {
		stopTimers();
	},
};
