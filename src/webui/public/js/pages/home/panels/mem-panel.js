/**
 * 首页仪表盘: 内存板块
 *
 * 堆内存 / 进程 RSS / 系统内存, 各自带占用条。
 */
import { createPanel, createBar } from "../widgets.js";
import { formatBytes } from "../format.js";

/** 内存板块: 堆内存 / 进程 RSS / 系统内存, 各自带占用条 */
export function createMemPanel() {
	const { section, body, setFoot } = createPanel("内存");

	const heap = createMemRow("堆内存");
	const rss = createMemRow("进程 RSS");
	const sysMem = createMemRow("系统内存");
	body.append(heap.row, rss.row, sysMem.row);

	const update = (state) => {
		const mem = state.memory ?? {};
		const sys = state.system ?? {};

		// 堆内存
		updateMemRow(heap, `${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
			mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : null);

		// 进程 RSS (占系统内存比例)
		const rssRatio = sys.totalmem > 0 ? mem.rss / sys.totalmem : null;
		const rssPct = rssRatio != null ? ` · 系统 ${(rssRatio * 100).toFixed(1)}%` : "";
		updateMemRow(rss, `${formatBytes(mem.rss)}${rssPct}`, rssRatio);

		// 系统内存 (使用率)
		const sysRatio = sys.totalmem > 0 ? (sys.totalmem - sys.freemem) / sys.totalmem : null;
		updateMemRow(sysMem, `${formatBytes(sys.freemem)} 可用 / ${formatBytes(sys.totalmem)}`, sysRatio);

		setFoot(`进程外部内存 ${formatBytes(mem.external)}`);
	};

	return { element: section, update };
}

/** 创建单行内存指标骨架: label/值 + 占用条; 内容由 updateMemRow 填充 */
function createMemRow(label) {
	const row = document.createElement("div");
	row.className = "mem-row";

	const head = document.createElement("div");
	head.className = "mem-row-head";
	const lab = document.createElement("span");
	lab.textContent = label;
	const val = document.createElement("span");
	val.className = "val";
	head.append(lab, val);

	const bar = createBar(null);
	row.append(head, bar.bar);

	return { row, val, bar };
}

/** 更新单行内存指标: 只改数值文本与占用条 */
function updateMemRow(memRow, value, ratio) {
	memRow.val.textContent = value;
	memRow.bar.update(ratio);
}
