/**
 * 首页仪表盘: CPU / 系统板块
 *
 * 核数型号 + 负载/运行时长/主机名。
 */
import { createPanel, createKV } from "../widgets.js";
import { formatUptime } from "../format.js";

/** CPU / 系统板块: 核数型号 + 负载/运行时长/主机名 */
export function createCpuPanel() {
	const { section, body, setFoot } = createPanel("CPU / 系统");

	// 主数值: 核数, 副行: 型号
	const main = document.createElement("div");
	main.className = "panel-main";
	body.append(main);

	const model = document.createElement("div");
	model.className = "panel-sub";
	body.append(model);

	const kvLoad = createKV("负载 (1/5/15)", "");
	const kvSpeed = createKV("主频", "");
	const kvUptime = createKV("系统运行", "");
	const kvHost = createKV("主机名", "");
	body.append(kvLoad.row, kvSpeed.row, kvUptime.row, kvHost.row);

	const update = (state) => {
		const sys = state.system ?? {};
		const cpu = sys.cpus ?? {};

		main.textContent = cpu.count ? `${cpu.count} 核` : "-";
		model.textContent = cpu.model ?? "";
		model.hidden = !cpu.model;

		// 负载: Windows 上恒为 0, 显示为不可用
		const loadavg = Array.isArray(sys.loadavg) ? sys.loadavg : [];
		const loadText = loadavg.length > 0 && loadavg.some((v) => v !== 0)
			? loadavg.map((v) => v.toFixed(2)).join(" / ")
			: "— (Windows 不支持)";
		kvLoad.setValue(loadText);
		kvSpeed.setValue(cpu.speed ? `${cpu.speed} MHz` : "-");
		kvUptime.setValue(formatUptime(sys.uptime));
		kvHost.setValue(sys.hostname ?? "-");

		setFoot(`${sys.type ?? "Unknown"} ${sys.release ?? ""} ${sys.arch ?? ""}`.trim());
	};

	return { element: section, update };
}
