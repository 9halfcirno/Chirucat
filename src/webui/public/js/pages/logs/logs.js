/**
 * 日志查看页面
 *
 * 通过 SSE (GET /api/get_log_stream) 接收实时日志流:
 * - 连接建立后服务器先回放最近历史, 再实时推送
 * - EventSource 断线自动重连, 页面只负责展示状态
 *
 * 渲染优化:
 * - 每行是单个 div + 纯文本, 不拆成多个 span
 * - rAF 批量渲染 + DocumentFragment, 避免逐条 DOM 写入
 * - 行数上限, 超出丢弃最旧的行
 * - 用户上滚查看历史时暂停自动滚动, 回到底部恢复跟随
 */
import toast from "../../spa/toast.js";
let source = null;   // EventSource 实例, destroy 时关闭
let listEl = null;   // 日志列表容器
let follow = true;   // 是否跟随最新日志
let queue = [];      // 待渲染的日志条目
let rafId = null;    // 批量渲染调度句柄

/** 日志行数上限: 长时间运行也不会累积过多 DOM */
const MAX_LINES = 2000;

export default {
	id: "logs",
	title: "日志",
	icon: "📋",
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

		// 状态行: 左侧连接状态, 右侧圆形清理按钮
		const head = document.createElement("div");
		head.className = "logs-head";

		const clearBtn = document.createElement("button");
		clearBtn.type = "button";
		clearBtn.className = "logs-clear-btn";
		clearBtn.title = "清理日志";
		clearBtn.setAttribute("aria-label", "清理日志");
		const icon = document.createElement("img");
		icon.src = "/img/icons/delete.svg";
		icon.alt = ""; // 装饰性图标, 悬停提示由按钮 title 提供
		clearBtn.append(icon);
		head.append(status, clearBtn);

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

		// 清理日志: 调后端清空历史缓冲, 同时清空页面上已渲染与排队中的行
		clearBtn.addEventListener("click", async () => {
			if (clearBtn.disabled) return;
			clearBtn.disabled = true;
			clearBtn.classList.add("loading");
			try {
				const res = await fetch("/api/clear_logs", { method: "POST" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				toast("日志已清理");
			} catch (err) {
				toast(`清理后端日志缓存失败: ${err.message}`, { type: "error", duration: 5000 });
			} finally {
				clearLogList();
				clearBtn.disabled = false;
				clearBtn.classList.remove("loading");
			}
		});

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
		follow = true;
		if (rafId != null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		queue = [];
	},
};

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
		// 单行纯文本, 避免拆成多个 span
		line.textContent = `[${entry.time}] [${level.toUpperCase()}] [${entry.name}] ${entry.message}`;
		frag.appendChild(line);
	}
	queue = [];

	// 移除空态占位
	list.querySelector(".logs-empty")?.remove();

	list.appendChild(frag);

	// 行数上限, 丢弃最旧的行
	while (list.childElementCount > MAX_LINES) {
		list.removeChild(list.firstElementChild);
	}

	if (follow) list.scrollTop = list.scrollHeight;
}
