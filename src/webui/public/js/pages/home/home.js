/**
 * 首页: 仪表盘
 *
 * 展示后端进程状态与基础性能信息, 按板块分组:
 * - 机器人: 运行状态列表 (不用进度条, 用状态点表示)
 * - 内存: 堆内存 / 进程 RSS / 系统内存
 * - CPU / 系统: 核数、型号、负载、系统运行时长
 * - 进程: 运行时长、PID、Node 版本等
 *
 * 数据源: /api/health (存活) + /api/get_state (性能)。每 5s 定时刷新。
 *
 * 性能优化: 面板骨架只在首次渲染时创建一次, 后续刷新仅更新
 * 文本 / 进度条 / 状态点 (增量更新), 不再整块重建 DOM, 减少浏览器
 * 节点创建与重排压力。bot 列表同样复用已有 <li>, 只对增删/顺序变化
 * 做最小 DOM 操作。
 */
const REFRESH_TIME = 5_000;

let refreshTimer = null;
let uptimeTimer = null;

/** 字节 → 人类可读字符串 (B/KB/MB/GB) */
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

/** 秒 → "Xd Xh Xm" 形式 */
function formatUptime(sec) {
	if (!Number.isFinite(sec) || sec < 0) return "-";
	sec = Math.floor(sec);
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (d > 0) return `${d}天 ${h}小时 ${m}分`;
	if (h > 0) return `${h}小时 ${m}分`;
	if (m > 0) return `${m}分 ${s}秒`;
	return `${s}秒`;
}

/** 占用率进度条颜色: 低绿 / 中黄 / 高红 */
function barColor(ratio) {
	if (ratio < 0.6) return "#5cb85c";
	if (ratio < 0.85) return "#f0ad4e";
	return "#d9534f";
}

/**
 * 创建进度条元素; 返回 { bar, update }
 * update(ratio) 只改填充条宽度/颜色, 不重建节点; ratio 非法 (非数字/越界) 时整条置灰
 */
function createBar(ratio) {
	const bar = document.createElement("div");
	bar.className = "bar";
	const fill = document.createElement("div");
	fill.className = "bar-fill";
	bar.append(fill);

	/** @param {number} r 占用率 0~1 */
	const update = (r) => {
		if (Number.isFinite(r)) {
			fill.classList.remove("bar-fill-na");
			const pct = Math.max(0, Math.min(1, r)) * 100;
			fill.style.width = `${pct}%`;
			fill.style.background = barColor(r);
		} else {
			// 数据缺失: 置灰占位条, 并清掉之前可能残留的内联样式
			fill.classList.add("bar-fill-na");
			fill.style.width = "";
			fill.style.background = "";
		}
	};
	update(ratio);
	return { bar, update };
}

/** 创建一行 kv 文本; 返回 { row, setValue }, setValue 只改右侧数值 */
function createKV(key, value) {
	const row = document.createElement("div");
	row.className = "kv";
	const k = document.createElement("span");
	k.className = "k";
	k.textContent = key;
	const v = document.createElement("span");
	v.className = "v";
	v.textContent = value;
	row.append(k, v);
	return { row, setValue(text) { v.textContent = text; } };
}

/**
 * 创建板块外壳
 * setFoot: 首次调用创建脚注, 之后只更新文本 (不会叠加多个 footer)
 * @param {string} title 板块标题
 * @returns {{ section: HTMLElement, body: HTMLElement, setFoot: (text: string) => void }}
 */
function createPanel(title) {
	const section = document.createElement("section");
	section.className = "card panel";

	const head = document.createElement("header");
	head.className = "panel-head";

	const titleEl = document.createElement("span");
	titleEl.className = "panel-title";
	titleEl.textContent = title;
	head.append(titleEl);

	const body = document.createElement("div");
	body.className = "panel-body";

	section.append(head, body);

	let footEl = null;
	return {
		section,
		body,
		setFoot(text) {
			if (!footEl) {
				footEl = document.createElement("footer");
				footEl.className = "panel-foot";
				section.append(footEl);
			}
			footEl.textContent = text;
		},
	};
}

/** 机器人板块: 运行数 + 每个 bot 的状态点列表 (不用占用条) */
function createBotPanel() {
	const { section, body, setFoot } = createPanel("机器人");

	// 主数值: 运行中 / 总数 (数值单独占 span, 避免整体赋值误删单位)
	const main = document.createElement("div");
	main.className = "panel-main";
	const mainText = document.createElement("span");
	mainText.className = "panel-main-value";
	const unit = document.createElement("span");
	unit.className = "unit";
	unit.textContent = "个运行中";
	main.append(mainText, unit);
	body.append(main);

	// bot 状态列表: 运行中的排前面, 再按 id 排序
	const list = document.createElement("ul");
	list.className = "bot-state-list";
	body.append(list);

	/** bot id → 对应 <li>, 复用节点做增量更新 */
	const itemMap = new Map();
	/** 空态提示 <li> (未连接核心 / 暂无机器人), 有真实列表时移除 */
	let emptyLi = null;

	const showEmpty = (text) => {
		if (!emptyLi) {
			emptyLi = document.createElement("li");
			emptyLi.className = "bot-state-item muted";
			list.append(emptyLi);
		}
		emptyLi.textContent = text;
	};

	const clearEmpty = () => {
		emptyLi?.remove();
		emptyLi = null;
	};

	const update = (state) => {
		const core = state.core;

		if (!core) {
			// WebUI 独立运行: 清空列表, 只保留提示
			mainText.textContent = "- / -";
			for (const li of itemMap.values()) li.remove();
			itemMap.clear();
			showEmpty("WebUI 独立运行, 未连接核心");
			setFoot("-");
			return;
		}

		mainText.textContent = `${core.runningBotCount} / ${core.botCount}`;
		setFoot(`已启用插件 ${core.enabledPluginCount} / ${core.pluginCount}`);

		const bots = (core.bots ?? [])
			.slice()
			.sort((a, b) => (b.running - a.running) || a.id.localeCompare(b.id));

		if (bots.length === 0) {
			for (const li of itemMap.values()) li.remove();
			itemMap.clear();
			showEmpty("暂无机器人, 在 bots/ 目录下创建");
			return;
		}

		clearEmpty();
		renderBotItems(list, itemMap, bots);
	};

	return { element: section, update };
}

/** 增量更新 bot 列表: 复用已有 <li>, 仅对新增/删除/顺序变化做最小 DOM 操作 */
function renderBotItems(list, itemMap, bots) {
	const seen = new Set();
	let anchor = null; // 排序后上一个已放置的 li
	for (const bot of bots) {
		seen.add(bot.id);
		let li = itemMap.get(bot.id);
		if (!li) {
			li = createBotItem(bot);
			itemMap.set(bot.id, li);
		} else {
			updateBotItem(li, bot);
		}
		// 按排序位置摆放: 已在正确位置时这些操作都是 no-op
		if (anchor == null) {
			if (list.firstChild !== li) list.prepend(li);
		} else if (li.previousSibling !== anchor) {
			anchor.after(li);
		}
		anchor = li;
	}
	// 移除已不存在的 bot
	for (const [id, li] of itemMap) {
		if (!seen.has(id)) {
			li.remove();
			itemMap.delete(id);
		}
	}
}

/** 创建单个 bot 列表项 (结构固定, 内容由 updateBotItem 填充) */
function createBotItem(bot) {
	const li = document.createElement("li");
	li.className = "bot-state-item";

	const dot = document.createElement("span");
	dot.className = "dot";

	const name = document.createElement("span");
	name.className = "bot-state-name";

	const idCode = document.createElement("code");

	li.append(dot, name, idCode);
	updateBotItem(li, bot);
	return li;
}

/** 更新单个 bot 列表项: 只改状态点类名与文本, 不重建 */
function updateBotItem(li, bot) {
	const [dot, name, idCode] = li.children;
	dot.className = `dot ${bot.running ? "on" : "off"}`;
	dot.title = bot.running ? "运行中" : "已停止";
	name.textContent = bot.name || bot.id;
	name.title = bot.name || bot.id;
	idCode.textContent = bot.id;
}

/** 内存板块: 堆内存 / 进程 RSS / 系统内存, 各自带占用条 */
function createMemPanel() {
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

/** CPU / 系统板块: 核数型号 + 负载/运行时长/主机名 */
function createCpuPanel() {
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

/** 进程板块: 运行时长 + PID / Node 版本等 */
function createProcessPanel() {
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

/** 创建单个状态项: 状态点 + 文本 */
function createStatusItem(label) {
	const item = document.createElement("span");
	item.className = "status-item";

	const dot = document.createElement("span");
	dot.className = "dot";

	const text = document.createElement("span");
	text.className = "status-text";
	text.textContent = label;

	item.append(dot, text);
	return { item, dot, text };
}

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
