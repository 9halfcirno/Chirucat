/**
 * 首页: 系统资源板块
 *
 * 两段双环图, 与字符画一致:
 *   cpu   [环图: 本进程 / 整机 叠加] 2.4% / 58%
 *   内存  [环图: 进程RSS / 使用中 叠加] 1% / 56%
 *
 * 两张环图共用同一套语义: 外环是系统视角 (整机 CPU / 系统已用内存),
 * 内环是本进程在同一基准下占掉的部分, 上下对比一眼能看出"机器忙是不是
 * 自己忙"。配色也共用一份, 图例靠文字区分维度。
 *
 * 字符画注明「剩下的都是环图的高度预留」: 面板与列等高, 环图靠 flex 吃掉
 * 多出来的纵向空间; 窄屏下高度按内容算, 由 .ring 的 min-height 兜底。
 */
import { createPanel } from "../widgets.js";
import { createRing } from "../ring.js";
import { formatBytes, formatPercent } from "../format.js";

/**
 * 双环配色: 外环系统/整机, 内环本进程 (CPU 与内存共用一份, 图例取同一份,
 * 保证颜色不跑偏)
 */
const LAYERS = ["var(--accent)", "var(--ok)"];

export function createResourcePanel() {
	const { section, body } = createPanel("系统资源");
	section.classList.add("res-panel");

	// ---- CPU: 双环 (外=整机, 内=本进程) + 图例 ----
	const cpu = createResItem("CPU");
	const cpuRing = createRing({ layers: LAYERS, label: "CPU 占用" });

	const cpuLegend = document.createElement("ul");
	cpuLegend.className = "ring-legend";
	const procCpuLegend = createLegendItem("框架", LAYERS[1]);
	const sysCpuLegend = createLegendItem("系统", LAYERS[0]);
	cpuLegend.append(procCpuLegend.li, sysCpuLegend.li);

	cpu.slot.append(cpuRing.element, cpuLegend);

	// ---- 内存: 双环 (外=系统已用, 内=进程 RSS) + 图例 ----
	const mem = createResItem("内存");
	const memRing = createRing({ layers: LAYERS, label: "内存占用" });

	const memLegend = document.createElement("ul");
	memLegend.className = "ring-legend";
	const rssLegend = createLegendItem("进程 RSS", LAYERS[1]);
	const usedLegend = createLegendItem("系统已用", LAYERS[0]);
	memLegend.append(rssLegend.li, usedLegend.li);

	mem.slot.append(memRing.element, memLegend);
	body.append(cpu.item, mem.item);

	const update = (state) => {
		const memory = state.memory ?? {};
		const sys = state.system ?? {};
		const cpus = sys.cpus ?? {};

		// ---- CPU ----
		// 整机占用 (usage, 0~100 整数) 与本进程占用 (state.cpu, 单核=100%) 都由
		// 后端相邻两次请求的差值算出; 内环超过 100% (多线程) 时弧长封顶为满环,
		// 真实数值看图例
		const usage = Number.isFinite(cpus.usage) ? cpus.usage : null;
		const procCpu = Number.isFinite(state.cpu) ? state.cpu : null;

		cpuRing.update({
			values: [usage == null ? null : usage / 100, procCpu == null ? null : procCpu / 100],
			text: usage == null ? "—" : `${usage}%`,
			sub: "系统",
		});

		procCpuLegend.value.textContent = procCpu == null ? "—" : `${procCpu.toFixed(1)}%`;
		sysCpuLegend.value.textContent = usage == null ? "—" : `${usage}%`;
		cpu.note.textContent = [
			cpus.count ? `${cpus.count} 核` : null,
			cpus.speed ? `${cpus.speed} MHz` : null,
		].filter(Boolean).join(" · ");
		cpu.note.title = procCpu != null
			? `"本进程"以单核满载为 100%, 多线程可超过 100% (弧长封顶为满环)`
			: "";

		// ---- 内存 ----
		const total = Number.isFinite(sys.totalmem) && sys.totalmem > 0 ? sys.totalmem : null;
		const usedRatio = total == null ? null : (total - sys.freemem) / total;
		const rssRatio = total == null ? null : memory.rss / total;

		memRing.update({
			values: [usedRatio, rssRatio],
			text: Number.isFinite(usedRatio) ? `${Math.round(usedRatio * 100)}%` : "—",
			sub: "已用",
		});

		rssLegend.value.textContent = formatPercent(rssRatio);
		usedLegend.value.textContent = formatPercent(usedRatio);
		mem.note.textContent = total == null ? "" : formatBytes(total);
	};

	return { element: section, update };
}

/** 创建一段环图: 顶部一行「名称 + 右侧附注」, 下面是环图与图例的落点 */
function createResItem(name) {
	const item = document.createElement("div");
	item.className = "res-item";

	const head = document.createElement("div");
	head.className = "res-item-head";

	const label = document.createElement("span");
	label.className = "res-name";
	label.textContent = name;

	const note = document.createElement("span");
	note.className = "res-note";

	head.append(label, note);

	const slot = document.createElement("div");
	slot.className = "res-slot";

	item.append(head, slot);
	return { item, note, slot };
}

/** 创建图例项: 色块 + 名称 + 数值 */
function createLegendItem(name, color) {
	const li = document.createElement("li");

	const swatch = document.createElement("span");
	swatch.className = "ring-swatch";
	swatch.style.background = color;

	const label = document.createElement("span");
	label.textContent = name;

	const value = document.createElement("span");
	value.className = "ring-legend-value";
	value.textContent = "—";

	li.append(swatch, label, value);
	return { li, value };
}
