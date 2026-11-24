/**
 * 首页: Chirucat 核心板块
 *
 * 字符画里就两行: 状态点 + "运行中", 以及 "已运行 1h23min45s"; 第三行是服务
 * 插件的启用/注册数 —— 它和 Bot 一样属于"核心带起来的东西", 放这里比塞进
 * 进程信息更贴切。
 * 状态点由 core/state/get 的 hasCore 决定 (WebUI 独立启动时核心不存在)。
 *
 * 「已运行」的基准不是进程 uptime: 核心支持重启替换 (重启会重建 Core 实例,
 * 进程本身不重启), 所以连着核心时用 core.runningAt 起算, 只有 WebUI 独立运行
 * (没有核心) 时才退回进程的启动时间。核心还在初始化 (runningAt 尚未落值,
 * WebUI 服务器先于 Bot/服务插件就绪) 时显示 "—" —— 拿进程时长顶上会虚报,
 * 不如不显示。
 * 文本由 render 里的每秒计时器直接改写 (见 setUptime), 不经过 5s 的接口刷新,
 * 秒位才会走。
 */
import { createPanel } from "../widgets.js";
import { formatUptimeShort } from "../format.js";

export function createCorePanel() {
	const { section, body } = createPanel("Chirucat核心");
	section.classList.add("core-panel");

	const stateRow = document.createElement("div");
	stateRow.className = "core-state";

	const dot = document.createElement("span");
	dot.className = "dot off";

	const stateText = document.createElement("span");
	stateText.className = "core-state-text";
	stateText.textContent = "正在检查...";

	stateRow.append(dot, stateText);

	const uptime = document.createElement("p");
	uptime.className = "core-uptime";
	uptime.textContent = "已运行 -";

	const services = document.createElement("p");
	services.className = "core-uptime";
	services.hidden = true;

	body.append(stateRow, uptime, services);

	/**
	 * 运行时长的起算时刻 (ms): 连着核心用核心的 runningAt, 独立运行退回进程
	 * startTime; 核心在初始化 (runningAt 还没落值) 时返回 null, 文本显示 "—"
	 */
	const uptimeBase = (state) => {
		if (state.hasCore) {
			return Number.isFinite(state.core?.runningAt) ? state.core.runningAt : null;
		}
		return Number.isFinite(state.startTime) ? state.startTime : null;
	};

	/** 只改运行时长文本 (每秒调用, 单独暴露给 render 的计时器); null 表示暂不可知 */
	const setUptime = (sec) => {
		uptime.textContent = sec == null ? "已运行 —" : `已运行 ${formatUptimeShort(sec)}`;
	};

	const update = (state) => {
		const connected = !!state.hasCore;

		dot.className = `dot ${connected ? "on" : "off"}`;
		dot.title = connected ? "核心已连接" : "未连接核心";
		stateText.textContent = connected ? "运行中" : "未连接 (WebUI 独立运行)";

		const base = uptimeBase(state);
		setUptime(base == null ? null : (Date.now() - base) / 1000);

		// 服务插件: 启用 / 注册 (services/ 目录的基础设施插件)
		const core = state.core;
		services.hidden = !core;
		if (core) {
			services.textContent = `服务插件 ${core.enabledServicePluginCount} / ${core.servicePluginCount}`;
		}
	};

	return { element: section, update, setUptime, uptimeBase };
}
