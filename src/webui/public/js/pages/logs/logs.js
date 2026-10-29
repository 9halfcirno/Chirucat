/**
 * 日志查看页面
 *
 * 通过 SSE (GET /api/get_log_stream) 接收实时日志流:
 * - 连接建立后服务器先回放最近历史, 再实时推送
 * - EventSource 断线自动重连, 页面只负责展示状态
 *
 * 过滤: 等级多选 + 按 Tag, 都在前端做 (SSE 仍收全量)
 * - 每行把过滤要用的元数据写进 dataset, 切换筛选只翻 hidden
 * - 不重建 DOM: 既没有 2000 行重排的开销, 也保住滚动位置与历史
 *
 * 渲染优化:
 * - 每行是单个 div + 纯文本, 不拆成多个 span
 * - rAF 批量渲染 + DocumentFragment, 避免逐条 DOM 写入
 * - 行数上限, 超出丢弃最旧的行
 * - 用户上滚查看历史时暂停自动滚动, 回到底部恢复跟随
 */
import toast from "../../spa/toast.js";
import { apiFetch } from "../../spa/auth.js";
import { createIconButton } from "../../spa/components/icon-button.js";
import { createFilterSelect } from "../../spa/components/filter-select.js";
let source = null;       // EventSource 实例, destroy 时关闭
let listEl = null;       // 日志列表容器
let levelFilter = null;  // 等级过滤下拉
let tagFilter = null;    // Tag 过滤下拉
let follow = true;       // 是否跟随最新日志
let queue = [];          // 待渲染的日志条目
let rafId = null;        // 批量渲染调度句柄

/** 与 utils/logger.ts 的 LOG_LEVELS 保持一致 */
const LOG_LEVELS = ["debug", "info", "warn", "error"];

/**
 * 没有 tag 的条目 (Core / WebUI / Service 等全局级日志) 归到这个分类下。
 */
const GLOBAL_TAG = "global";

/** 当前筛选: levels 为选中的等级集合, tag 为空串表示不限定 tag */
let filters = { levels: new Set(LOG_LEVELS), tag: "" };

/** 日志行数上限: 长时间运行也不会累积过多 DOM */
const MAX_LINES = 2000;

export default {
	id: "logs",
	title: "日志",
	styles: ["/js/pages/logs/logs.css"],

	render(container) {
		container.classList.add("logs-page");

		const h1 = document.createElement("div");
		h1.textContent = "日志";

		const tip = document.createElement("p");
		tip.className = "muted";
		tip.textContent = "实时日志流 (SSE)";

		const status = document.createElement("div");
		status.className = "logs-status connecting";
		status.textContent = "连接中";

		// 顶行: 连接状态 + 过滤控件, 清理按钮贴右
		const head = document.createElement("div");
		head.className = "logs-head";

		const clearBtn = createIconButton("/img/icons/delete.svg", async () => {
			try {
				const res = await apiFetch("/api/clear_logs", { method: "POST" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				toast("日志已清理");
			} catch (err) {
				toast(`清理后端日志缓存失败: ${err.message}`, { type: "error", duration: 5000 });
			} finally {
				clearLogList();
			}
		})
		clearBtn.title = "清理日志";
		clearBtn.setAttribute("aria-label", "清理日志");

		// 过滤控件: 等级多选 + Tag 单选, 切换即时作用于已渲染的历史行
		levelFilter = createFilterSelect({
			multiple: true,
			allLabel: "全部等级",
			items: LOG_LEVELS.map(level => ({ value: level, label: level.toUpperCase() })),
			values: LOG_LEVELS,
			onChange: (values) => {
				filters.levels = new Set(values);
				applyFilters();
			},
		});

		tagFilter = createFilterSelect({
			items: [{ value: "", label: "全部 Tag" }],
			values: "",
			onChange: (value) => {
				filters.tag = Array.isArray(value) ? (value[0] ?? "") : value;
				applyFilters();
			},
		});

		// 两个筛选控件与"已连接"、清理按钮同级同排, 不单独包卡片
		head.append(status, createField("等级", levelFilter.el), createField("分类", tagFilter.el), clearBtn);

		// Tag 列表异步补进下拉: SSE 不等它, 过滤只读条目自带的 tag
		loadTagOptions();

		listEl = document.createElement("div");
		listEl.className = "log-list";
		listEl.setAttribute("role", "log");

		// 空态占位, 第一条日志到达时移除
		const empty = document.createElement("p");
		empty.className = "muted logs-empty";
		empty.textContent = "暂无日志";
		listEl.appendChild(empty);

		container.append(h1, head, listEl);

		// 滚动跟随: 接近底部才自动滚动, 上滚即暂停
		listEl.addEventListener("scroll", () => {
			const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 24;
			follow = nearBottom;
		});

		const setStatus = (state, text) => {
			status.className = `logs-status ${state}`;
			status.textContent = text;
		};


		source = new EventSource("/api/get_log_stream");
		source.addEventListener("open", () => setStatus("on", "已连接"));
		source.addEventListener("error", () => setStatus("connecting", "重连中…"));
		source.addEventListener("log", (e) => {
			try {
				enqueue(JSON.parse(e.data));
			} catch (err) {
				console.warn("[logs] 解析日志条目失败:", err);
			}
		});
	},

	destroy() {
		source?.close();
		source = null;
		listEl = null;
		// 浮层挂在 body 上, 页面切走时必须收起
		levelFilter?.close();
		tagFilter?.close();
		levelFilter = null;
		tagFilter = null;
		follow = true;
		if (rafId != null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		queue = [];
		// 模块级筛选状态: 不重置会让下次进入页面拿着上次的条件看到空白列表
		filters = { levels: new Set(LOG_LEVELS), tag: "" };
	},
};

/** 带小标签的筛选字段 */
function createField(label, control) {
	const wrap = document.createElement("div");
	wrap.className = "logs-field";
	const name = document.createElement("span");
	name.className = "logs-field-label";
	name.textContent = label;
	wrap.append(name, control);
	return wrap;
}

/** 把 Tag 列表灌进下拉; 拉不到就只留"全部 / 全局", 不影响等级过滤 */
async function loadTagOptions() {
	try {
		const res = await apiFetch("/api/get_bot_list");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		// 响应回来时页面可能已经切走
		if (!tagFilter) return;
		tagFilter.setItems([
			{ value: "", label: "全部 Tag" }, { value: GLOBAL_TAG, label: "全局" },
			...(data.bots ?? []).map(bot => ({ value: bot.id, label: `Bot ${bot.name || bot.id}` })),
		]);
	} catch {
		// 忽略: 等级过滤与按"全局"过滤仍然可用
	}
}

/** 单行是否命中当前筛选 */
function matchFilter(line) {
	return filters.levels.has(line.dataset.level)
		&& (filters.tag === "" || filters.tag === line.dataset.tag);
}

/** 切换筛选: 只翻可见性, 不重建 DOM */
function applyFilters() {
	const list = listEl;
	if (!list) return;
	for (const line of list.querySelectorAll(".log-line")) {
		line.hidden = !matchFilter(line);
	}
	syncEmpty(list);
	if (follow) list.scrollTop = list.scrollHeight;
}

/** 空态占位: 一行都没有说"暂无日志", 有但都被筛掉说没有匹配 */
function syncEmpty(list) {
	const placeholder = list.querySelector(".logs-empty");
	if (list.querySelector(".log-line:not([hidden])")) {
		placeholder?.remove();
		return;
	}

	const text = list.querySelector(".log-line") ? "没有匹配当前筛选的日志" : "暂无日志";
	if (placeholder) {
		placeholder.textContent = text;
		return;
	}

	const created = document.createElement("p");
	created.className = "muted logs-empty";
	created.textContent = text;
	list.prepend(created);
}

/** 清空页面上的日志列表: 丢弃排队与已渲染的行, 恢复空态 */
function clearLogList() {
	// 丢弃尚未渲染的排队条目, 避免清理后又被补绘
	if (rafId != null) {
		cancelAnimationFrame(rafId);
		rafId = null;
	}
	queue = [];

	const list = listEl;
	if (!list) return;
	list.replaceChildren();
	const empty = document.createElement("p");
	empty.className = "muted logs-empty";
	empty.textContent = "暂无日志";
	list.appendChild(empty);

	follow = true;
	list.scrollTop = 0;
}

/** 入队一条日志, 统一在下一帧批量渲染 */
function enqueue(entry) {
	queue.push(entry);
	if (rafId != null) return;
	rafId = requestAnimationFrame(flush);
}

/** 批量渲染排队中的日志 */
function flush() {
	rafId = null;
	const list = listEl;
	if (!list) {
		queue = [];
		return;
	}

	const frag = document.createDocumentFragment();
	for (const entry of queue) {
		const line = document.createElement("div");
		const level = entry.level ?? "info";
		line.className = `log-line level-${level}`;
		// 过滤要用的元数据: 切筛选时只读 dataset, 不必回头找原始条目
		line.dataset.level = level;
		line.dataset.tag = entry.tag ?? GLOBAL_TAG;
		// 单行纯文本, 避免拆成多个 span
		line.textContent = `[${entry.time}] [${level.toUpperCase()}] [${entry.name}] ${entry.message}`;
		// 新到的日志也要守当前筛选, 否则条件会被后续输出冲掉
		line.hidden = !matchFilter(line);
		frag.appendChild(line);
	}
	queue = [];

	list.appendChild(frag);

	// 行数上限, 丢弃最旧的行
	while (list.childElementCount > MAX_LINES) {
		list.removeChild(list.firstElementChild);
	}

	// 空态跟随可见性: 全被筛掉时把占位补回来
	syncEmpty(list);

	if (follow) list.scrollTop = list.scrollHeight;
}
