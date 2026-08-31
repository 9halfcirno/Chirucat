/**
 * 首页: 仪表盘 (入口)
 *
 * 展示后端进程状态与基础性能信息, 按板块分组:
 * - 机器人: 运行状态列表 (不用进度条, 用状态点表示)     → panels/bot-panel.js
 * - 内存: 堆内存 / 进程 RSS / 系统内存                   → panels/mem-panel.js
 * - CPU / 系统: 核数、型号、负载、系统运行时长            → panels/cpu-panel.js
 * - 进程: 运行时长、PID、Node 版本等                     → panels/process-panel.js
 *
 * 通用骨架 (进度条 / kv / 面板外壳 / 状态项) 在 widgets.js,
 * 数值格式化工具在 format.js。
 *
 * 数据源: /api/health (存活) + /api/get_state (性能)。每 5s 定时刷新。
 *
 * 性能优化: 面板骨架只在首次渲染时创建一次, 后续刷新仅更新
 * 文本 / 进度条 / 状态点 (增量更新), 不再整块重建 DOM, 减少浏览器
 * 节点创建与重排压力。bot 列表同样复用已有 <li>, 只对增删/顺序变化
 * 做最小 DOM 操作。
 */
import { createStatusItem } from "./widgets.js";
import { createBotPanel } from "./panels/bot-panel.js";
import { createMemPanel } from "./panels/mem-panel.js";
import { createCpuPanel } from "./panels/cpu-panel.js";
import { createProcessPanel } from "./panels/process-panel.js";
import { formatUptime } from "./format.js";

const REFRESH_TIME = 5_000;

let refreshTimer = null;
let uptimeTimer = null;

export default {
	id: "home",
	title: "首页",
	icon: "🏠",
	styles: ["/js/pages/home/home.css"],

	async render(container) {

		// 状态条: 服务器状态 + 核心连接状态, 用状态点表示 (绿=正常, 灰=未连接, 红=异常)
		const status = document.createElement("div");
		status.id = "status";

		const serverItem = createStatusItem("服务器");
		const coreItem = createStatusItem("核心");
		serverItem.text.textContent = "正在检查...";
		coreItem.text.textContent = "正在检查...";
		status.append(serverItem.item, coreItem.item);

		// 板块网格
		const grid = document.createElement("div");
		grid.className = "panel-grid";

		container.append(status, grid);

		/** 四个性能面板 (首次创建后复用, 每 5s 增量更新, 不重建 DOM) */
		let panels = null;
		/** 进程运行时长文本节点, 由每秒 uptimeTimer 直接更新 */
		let uptimeText = null;
		/** 最近一次 get_state 返回的进程启动时间戳; 用于运行时长每秒自增 */
		let currentStartTime = null;

		// 每秒按启动时间戳重算运行时长, 不等 5s 刷新 (用 Date.now 差值, 无累计误差)
		const updateUptime = () => {
			if (currentStartTime == null || uptimeText == null) return;
			uptimeText.textContent = formatUptime((Date.now() - currentStartTime) / 1000);
		};

		// health 与 get_state 独立处理: 任一失败只在对应位置报告, 不影响另一项已有展示
		const refresh = async () => {
			// ---- 服务器存活 (/api/health): 只更新状态条 ----
			try {
				const healthRes = await fetch("/api/health");
				if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
				const health = await healthRes.json();

				const ok = health.status === "ok";
				serverItem.dot.className = ok ? "dot on" : "dot error";
				serverItem.text.textContent = ok
					? `服务器正常 (${new Date(health.time).toLocaleString()})`
					: `服务器异常 (${health.status})`;
			} catch (err) {
				// 服务器不可达: 服务器/核心状态点都标记异常/未知
				serverItem.dot.className = "dot error";
				serverItem.text.textContent = `无法连接服务器: ${err.message}`;
				coreItem.dot.className = "dot off";
				coreItem.text.textContent = "状态未知";
			}

			// ---- 性能数据 (/api/get_state): 失败时只在板块区域写错误信息, 不清空已有板块 ----
			try {
				const stateRes = await fetch("/api/get_state");
				if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
				const state = await stateRes.json();

				// 成功刷新: 移除错误提示 (增量更新不清空 grid, 需显式移除)
				grid.querySelectorAll(".grid-error").forEach((el) => el.remove());

				if (panels) {
					updatePanels(panels, state);
				} else {
					// 首次成功: 创建面板骨架并挂载, 之后只增量更新
					({ panels, uptimeText } = createPanels(grid, state));
				}

				// 核心连接状态点
				coreItem.dot.className = state.hasCore ? "dot on" : "dot off";
				coreItem.text.textContent = state.hasCore ? "核心已连接" : "核心未连接";

				currentStartTime = Number.isFinite(state.startTime) ? state.startTime : null;
				updateUptime();
			} catch (err) {
				showGridError(grid, `获取性能数据失败: ${err.message}`);
				coreItem.dot.className = "dot off";
				coreItem.text.textContent = "状态未知";
			}
		};

		await refresh();
		refreshTimer = setInterval(refresh, REFRESH_TIME);
		uptimeTimer = setInterval(updateUptime, 1_000);
	},

	destroy() {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
		if (uptimeTimer) {
			clearInterval(uptimeTimer);
			uptimeTimer = null;
		}
	},
};

/**
 * 首次渲染: 创建四个面板骨架并挂载到网格, 随后立即增量更新一次。
 * 返回面板数组与运行时长文本节点, 供后续 updatePanels / uptimeTimer 复用。
 */
function createPanels(grid, state) {
	const bot = createBotPanel();
	const mem = createMemPanel();
	const cpu = createCpuPanel();
	const proc = createProcessPanel();
	const panels = [bot, mem, cpu, proc];

	grid.append(...panels.map((p) => p.element));
	updatePanels(panels, state);

	return { panels, uptimeText: proc.uptimeText };
}

/** 增量更新四个面板: 只改文本/进度条/状态点, 不重建任何节点 */
function updatePanels(panels, state) {
	for (const p of panels) p.update(state);
}

/**
 * 在板块网格顶部显示错误信息, 不清空/不替换已有板块。
 * 成功刷新时由 refresh 显式移除错误提示。
 */
function showGridError(grid, message) {
	grid.querySelectorAll(".grid-error").forEach((el) => el.remove());
	const errBox = document.createElement("div");
	errBox.className = "page-error grid-error";
	errBox.textContent = message;
	grid.prepend(errBox);
}
