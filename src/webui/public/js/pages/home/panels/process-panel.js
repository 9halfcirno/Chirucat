/**
 * 首页仪表盘: 进程板块
 *
 * 运行时长 + PID / Node 版本等。
 */
import { createPanel, createKV } from "../widgets.js";
import { formatUptime } from "../format.js";

/** 进程板块: 运行时长 + PID / Node 版本等 */
export function createProcessPanel() {
	const { section, body, setFoot } = createPanel("进程");

	// 主数值: 运行时长, 每秒自增 (数值单独占 span, 避免整体赋值误删单位)
	const main = document.createElement("div");
	main.className = "panel-main uptime-value";
	const mainText = document.createElement("span");
	mainText.className = "panel-main-value";
	const unit = document.createElement("span");
	unit.className = "unit";
	unit.textContent = "运行时长";
	main.append(mainText, unit);
	body.append(main);

	const kvPid = createKV("PID", "");
	const kvNode = createKV("Node", "");
	const kvPlatform = createKV("平台", "");
	const kvStart = createKV("启动时间", "");
	const kvCwd = createKV("工作目录", "");
	body.append(kvPid.row, kvNode.row, kvPlatform.row, kvStart.row, kvCwd.row);

	const update = (state) => {
		mainText.textContent = formatUptime(state.uptime);
		kvPid.setValue(state.pid);
		kvNode.setValue(state.node);
		kvPlatform.setValue(`${state.platform} / ${state.arch}`);
		kvStart.setValue(new Date(state.startTime).toLocaleString());
		kvCwd.setValue(state.cwd ?? "");
		kvCwd.row.hidden = !state.cwd;

		setFoot(`已连接核心: ${state.hasCore ? "是" : "否"}`);
	};

	// 供 render 的每秒自增计时器直接更新文本节点, 不经过 DOM 查询
	return { element: section, update, uptimeText: mainText };
}
