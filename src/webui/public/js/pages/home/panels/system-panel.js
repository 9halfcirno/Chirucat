/**
 * 首页: 操作系统板块
 *
 * 字符画里是「操作系统 ...」, 内容取 os 的这几项: 主机名 / 系统版本 /
 * 架构 / 系统运行时长 / 负载 / CPU 规格, CPU 型号太长, 放脚注单行截断。
 *
 * CPU 占用率不在此卡: 它属于「系统资源」的环图。
 */
import { createPanel, createKV } from "../widgets.js";
import { formatUptime } from "../format.js";

export function createSystemPanel() {
	const { section, body, setFoot } = createPanel("操作系统");

	const kvHost = createKV("主机名", "-");
	const kvType = createKV("系统", "-");
	const kvArch = createKV("架构", "-");
	const kvUptime = createKV("系统运行", "-");
	const kvLoad = createKV("负载 (1/5/15)", "-");
	const kvCpu = createKV("CPU", "-");
	body.append(kvHost.row, kvType.row, kvArch.row, kvUptime.row, kvLoad.row, kvCpu.row);

	const update = (state) => {
		const sys = state.system ?? {};
		const cpus = sys.cpus ?? {};

		kvHost.setValue(sys.hostname ?? "-");
		kvType.setValue(`${sys.type ?? "Unknown"} ${sys.release ?? ""}`.trim());
		kvArch.setValue(sys.arch ?? "-");
		kvUptime.setValue(formatUptime(sys.uptime));

		// 负载: Windows 上 os.loadavg() 恒为 [0,0,0], 显示为不可用
		const loadavg = Array.isArray(sys.loadavg) ? sys.loadavg : [];
		const hasLoad = loadavg.length > 0 && loadavg.some((v) => v !== 0);
		kvLoad.setValue(hasLoad ? loadavg.map((v) => v.toFixed(2)).join(" / ") : "— (Windows 不支持)");

		kvCpu.setValue(cpus.count
			? `${cpus.count} 核${cpus.speed ? ` · ${cpus.speed} MHz` : ""}`
			: "-");

		setFoot(cpus.model ?? "");
	};

	return { element: section, update };
}
