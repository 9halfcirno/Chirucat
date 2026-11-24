/**
 * 首页: 进程信息板块
 *
 * 上半部分是进程的静态/半静态信息 (PID / Node / 平台 / 启动时间 / 工作目录),
 * 下半部分是两块随刷新变化的东西:
 *
 * - 事件循环延迟 P99: 判断"卡是不是这个进程造成的"最直接的数 —— CPU 占用
 *   在系统资源卡 (整机环图 + 本进程), 这里不再重复。
 * - 内存构成条: 把 RSS 拆开堆在一根条上。注意 Node 的 memoryUsage() 里
 *   arrayBuffers 是 external 的子集, 直接两段并排会重复计数, 所以先用
 *   external 减掉 arrayBuffers 再各画一段; 最后一段是残差 (代码段、栈、
 *   尚未归还系统的堆页), 保证整根条正好铺满 RSS。
 *
 */
import { createPanel, createKV } from "../widgets.js";
import { formatBytes } from "../format.js";

/**
 * 内存构成条的段, 顺序即条上的顺序
 * pick 取字节数; 数值为 0 的段会隐藏 (否则每段都会在条上留下 1px 缝隙)
 * hint 是悬停说明 —— 其中"其他"经常占掉大半, 不解释一下容易被当成统计错误
 */
const MEM_SEGMENTS = [
	{ label: "堆已用", color: "var(--accent)", pick: (m) => m.heapUsed, hint: "V8 堆已使用的部分" },
	// 同色系淡化: 语义上仍属"堆", 但一眼能看出没被用到
	{
		label: "堆余量",
		color: "color-mix(in srgb, var(--accent) 38%, transparent)",
		pick: (m) => m.heapTotal - m.heapUsed,
		hint: "V8 已向系统申请、堆上还没用到的部分",
	},
	{ label: "外部", color: "var(--type-service)", pick: (m) => m.external - m.arrayBuffers, hint: "C++ 对象占用的内存 (不含 ArrayBuffer)" },
	{ label: "ArrayBuffer", color: "var(--type-normal)", pick: (m) => m.arrayBuffers, hint: "ArrayBuffer 与 Buffer 的底层内存 (图片、文件缓冲等)" },
	// 残差: RSS 减掉上面几项后还剩的 (代码段 / 栈 / 未归还系统的堆页)
	{
		label: "其他",
		color: "var(--fg-subtle)",
		pick: (m) => m.rss - m.heapTotal - m.external,
		hint: "RSS 里不属于 V8 堆与外部内存的部分: 代码段、线程栈、已释放但尚未归还系统的堆页等",
	},
];

export function createProcessPanel() {
	const { section, body } = createPanel("进程信息");

	// ---- 进程基本信息 ----
	const kvPid = createKV("PID", "-");
	const kvNode = createKV("Node", "-");
	const kvPlatform = createKV("平台", "-");
	const kvStart = createKV("启动时间", "-");
	const kvCwd = createKV("工作目录", "-");

	// ---- 健康度: 事件循环 (进程 CPU 在系统资源卡) ----
	const loopHint = "事件循环延迟的 P99; 悬停可看窗口内最大值";
	const kvLoop = createKV("事件循环", "—");
	kvLoop.row.title = loopHint;

	// ---- 内存构成 ----
	const compose = createMemCompose();

	body.append(
		kvPid.row, kvNode.row, kvPlatform.row, kvStart.row, kvCwd.row,
		kvLoop.row,
		compose.element,
	);

	const update = (state) => {
		const memory = state.memory ?? {};
		const loop = state.eventLoop ?? {};

		kvPid.setValue(state.pid ?? "-");
		kvNode.setValue(state.node ?? "-");
		kvPlatform.setValue(`${state.platform ?? "-"} / ${state.arch ?? "-"}`);
		kvStart.setValue(Number.isFinite(state.startTime)
			? new Date(state.startTime).toLocaleString()
			: "-");

		kvCwd.setValue(state.cwd ?? "-");
		kvCwd.row.hidden = !state.cwd;

		const hasP99 = Number.isFinite(loop.p99);
		kvLoop.setValue(hasP99 ? `P99 ${loop.p99.toFixed(1)} ms` : "—");
		kvLoop.row.title = hasP99 && Number.isFinite(loop.max)
			? `事件循环延迟: P99 ${loop.p99.toFixed(1)} ms, 窗口内最大 ${loop.max.toFixed(1)} ms`
			: loopHint;

		compose.update(memory);
	};

	return { element: section, update };
}

/** 创建内存构成区块: 标题行 (总量) + 堆叠条 + 图例 */
function createMemCompose() {
	const element = document.createElement("div");
	element.className = "mem-compose";

	const head = document.createElement("div");
	head.className = "mem-compose-head";

	const title = document.createElement("span");
	title.textContent = "内存构成";

	const total = document.createElement("span");
	total.className = "mem-compose-total";

	head.append(title, total);

	const stack = document.createElement("div");
	stack.className = "mem-stack";

	const legend = document.createElement("ul");
	legend.className = "mem-legend";

	/** 与 MEM_SEGMENTS 一一对应的条段与图例项 (复用节点, 只改宽度与数值) */
	const parts = MEM_SEGMENTS.map((seg) => {
		const bar = document.createElement("span");
		bar.className = "mem-seg";
		bar.style.background = seg.color;
		bar.title = `${seg.label}: ${seg.hint}`;
		stack.append(bar);

		const li = document.createElement("li");
		li.title = `${seg.label}: ${seg.hint}`;

		const swatch = document.createElement("span");
		swatch.className = "mem-swatch";
		swatch.style.background = seg.color;

		const name = document.createElement("span");
		name.textContent = seg.label;

		const value = document.createElement("span");
		value.className = "mem-value";
		value.textContent = "—";

		li.append(swatch, name, value);
		legend.append(li);

		return { seg, bar, value };
	});

	element.append(head, stack, legend);

	const update = (memory) => {
		const rss = memory.rss;

		// 没有 RSS 就算不出比例, 整块收起 (不留一条空条)
		if (!Number.isFinite(rss) || rss <= 0) {
			element.hidden = true;
			return;
		}
		element.hidden = false;
		total.textContent = `RSS ${formatBytes(rss)}`;

		for (const part of parts) {
			const bytes = Math.max(0, part.seg.pick(memory) || 0);
			// 宽度用 flex-grow 而不是百分比: 段间留了 1px 缝隙, 按比例分剩余空间
			// 才不会因为缝隙把总和顶出条外
			part.bar.style.flexGrow = String(bytes);
			part.bar.hidden = bytes <= 0;
			part.value.textContent = formatBytes(bytes);
		}
	};

	return { element, update };
}
