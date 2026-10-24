/**
 * 受理人 (单个 Bot) — 受理人服务注册的 Bot 详情窗口页面
 *
 * 适配器是 Bot 级的, 所以这里只做 Bot 详情窗口里的一个子页, 不占一级导航。
 * 页面只做三件事: 看状态、手工换受理人、清掉某个会话的状态。
 *
 * 数据全部来自本服务注册的端点 `/service/chirucat-acceptor/api/acceptor_state`,
 * 三种操作都返回操作后的完整快照 —— 点一下就能拿到新画面。
 *
 * 自动刷新: 每 5 秒拉一次。表格是整块重建的, 所以用户刚碰过页面(3 秒内)时跳过
 * 这一轮, 避免自绘下拉在展开状态下被抽走。容器从文档里移除后停止轮询。
 */
import { callServiceAPI } from "/js/spa/api.js";
import { createButton } from "/js/spa/components/button.js";
import { createDialogWindow } from "/js/spa/components/dialog-window.js";
import { createSelect } from "/js/spa/components/select.js";
import toast from "/js/spa/toast.js";

/** 端点所属的服务插件 id (清单里的 id) */
const SERVICE = "chirucat-acceptor";
/** 本服务注册的端点名 */
const ENDPOINT = "acceptor_state";
/** 自动刷新间隔 */
const REFRESH_MS = 5000;
/** 用户刚操作过时暂停刷新的时长 */
const IDLE_MS = 3000;

/** 会话类型的中文名 */
const TYPE_NAMES = { private: "私聊", group: "群", channel: "频道" };

export default {
	title: "受理人",

	/**
	 * @param {HTMLElement} div 窗口内容容器
	 * @param {{ id: string, name?: string }} bot 当前 Bot
	 */
	render(div, bot) {
		renderAcceptorPage(div, bot);
	},
};

/** 渲染整个页面 */
function renderAcceptorPage(div, bot) {
	div.classList.add("acceptor-page");

	/** 最近一次交互时刻: 表格重建会抽走正在操作的下拉, 刚碰过就先别动 */
	let touchedAt = 0;
	const markTouched = () => { touchedAt = Date.now(); };
	div.addEventListener("pointerdown", markTouched, true);
	div.addEventListener("focusin", markTouched, true);

	// ---- 头部卡片: 模式、当前参数、刷新 ----
	const modeBadge = document.createElement("span");
	modeBadge.className = "acceptor-badge off";
	modeBadge.textContent = "加载中";

	const refreshBtn = createButton("刷新", () => { void load(); });
	refreshBtn.classList.add("acceptor-refresh");

	const headRow = document.createElement("div");
	headRow.className = "acceptor-head";

	const title = document.createElement("h3");
	title.textContent = "受理人";
	const spacer = document.createElement("span");
	spacer.className = "acceptor-spacer";
	headRow.append(title, modeBadge, spacer, refreshBtn);

	const modeHint = document.createElement("p");
	modeHint.className = "acceptor-hint muted";

	const paramsLine = document.createElement("p");
	paramsLine.className = "acceptor-hint muted acceptor-params";

	const headCard = document.createElement("section");
	headCard.className = "card glass acceptor-card";
	headCard.append(headRow, modeHint, paramsLine);

	// ---- 表格卡片 ----
	const updated = document.createElement("span");
	updated.className = "acceptor-updated muted";

	const tableTitle = document.createElement("h3");
	tableTitle.textContent = "逻辑会话";

	const tableHeadRow = document.createElement("div");
	tableHeadRow.className = "acceptor-head";
	const tableSpacer = document.createElement("span");
	tableSpacer.className = "acceptor-spacer";
	tableHeadRow.append(tableTitle, tableSpacer, updated);

	const table = document.createElement("table");
	table.className = "acceptor-table";

	const thead = document.createElement("thead");
	const headTr = document.createElement("tr");
	for (const text of ["逻辑会话", "受理人", "窗口派发", "证据", "冷却", "操作"]) {
		const th = document.createElement("th");
		th.textContent = text;
		headTr.appendChild(th);
	}
	thead.appendChild(headTr);

	const tbody = document.createElement("tbody");
	table.append(thead, tbody);

	const tableWrap = document.createElement("div");
	tableWrap.className = "acceptor-table-wrap";
	tableWrap.appendChild(table);

	const tableCard = document.createElement("section");
	tableCard.className = "card glass acceptor-card";
	tableCard.append(tableHeadRow, tableWrap);

	div.append(headCard, tableCard);

	/** 首屏提示: 还没拿到数据前就说明这一页是干什么的 */
	paintEmpty("加载中…");

	void load();

	// ---- 轮询 ----
	const timer = setInterval(() => {
		if (!div.isConnected) {
			clearInterval(timer);
			return;
		}
		if (Date.now() - touchedAt < IDLE_MS) return;
		void load();
	}, REFRESH_MS);

	/* -------------------- 数据 -------------------- */

	async function load() {
		try {
			const snapshot = await callServiceAPI(SERVICE, ENDPOINT, { action: "state", botId: bot.id });
			paint(snapshot);
		} catch (e) {
			paintError(`读取受理人状态失败: ${e.message}`);
		}
	}

	/** 用一份快照刷新整页 */
	function paint(snapshot) {
		paintHead(snapshot);
		paintTable(snapshot);
		updated.textContent = `更新于 ${new Date(snapshot.now).toLocaleTimeString("zh-CN")}`;
	}

	function paintHead(snapshot) {
		if (!snapshot.enabled) {
			modeBadge.className = "acceptor-badge off";
			modeBadge.textContent = "判定已关闭";
			modeHint.textContent = "配置里关掉了判定, 所有消息照常放行。";
		} else if (snapshot.dryRun) {
			modeBadge.className = "acceptor-badge dry";
			modeBadge.textContent = "演练模式";
			modeHint.textContent =
				"判定照常演进, 但不会拦截任何消息。确认参数与行为正常后, 在服务配置里关闭「演练模式」。";
		} else {
			modeBadge.className = "acceptor-badge live";
			modeBadge.textContent = "正式模式";
			modeHint.textContent = "每个逻辑会话只放行受理人的消息, 其余适配器的派发会被拦下。";
		}

		const t = snapshot.thresholds;
		const f = snapshot.fastPath;
		const parts = [
			`窗口 ${fmtSpan(snapshot.windowMs)}`,
			`转移证据 ${t.transferThreshold} 次`,
			`回切证据 ${t.switchBackThreshold} 次`,
			`冷却 ${fmtSpan(t.cooldownMs)}`,
		];
		if (f.enabled) parts.push(`@ 快速通道 ${f.consecutive} 次`);
		paramsLine.textContent = parts.join(" · ");
	}

	/** 重建表格主体 */
	function paintTable(snapshot) {
		tbody.textContent = "";

		if (snapshot.sessions.length === 0) {
			paintEmpty(
				snapshot.enabled
					? "这个 Bot 还没有参与判定的逻辑会话。需要两个适配器绑定到同一个逻辑会话(例如 /bind_session), 并且收到过消息后才会出现在这里。"
					: "判定已关闭, 不会记录任何会话。",
			);
			return;
		}

		for (const session of snapshot.sessions) {
			tbody.appendChild(createRow(session, snapshot));
		}
	}

	/** 一行: 会话 / 受理人 / 派发 / 证据 / 冷却 / 操作 */
	function createRow(session, snapshot) {
		const tr = document.createElement("tr");

		// ---- 逻辑会话 ----
		const sessionCell = document.createElement("td");
		const members = document.createElement("div");
		members.className = "acceptor-members";

		if (session.members.length > 0) {
			for (const member of session.members) {
				const line = document.createElement("span");
				line.className = "acceptor-member";
				line.textContent = `${TYPE_NAMES[member.type] ?? member.type} ${member.id} · ${member.platform}`;
				members.appendChild(line);
			}
		} else {
			const line = document.createElement("span");
			line.className = "acceptor-member";
			line.textContent = "（没有成员记录）";
			members.appendChild(line);
		}

		const union = document.createElement("div");
		union.className = "acceptor-union";
		union.textContent = shortId(session.unionId);
		union.title = session.unionId;

		sessionCell.append(members, union);

		// ---- 受理人 ----
		const acceptorCell = document.createElement("td");
		acceptorCell.className = "num";
		if (session.acceptor) {
			const chip = document.createElement("span");
			chip.className = "acceptor-chip current";
			chip.textContent = session.acceptor;
			acceptorCell.appendChild(chip);

			const since = document.createElement("div");
			since.className = "acceptor-evidence muted";
			since.textContent = session.transfers > 0
				? `${fmtAgo(session.since, snapshot.now)} · 已转移 ${session.transfers} 次`
				: `${fmtAgo(session.since, snapshot.now)} · 初始受理人`;
			acceptorCell.appendChild(since);
		} else {
			acceptorCell.textContent = "未选举";
		}

		// ---- 窗口派发 ----
		const countsCell = document.createElement("td");
		const chips = document.createElement("div");
		chips.className = "acceptor-adapters";
		const adapters = Object.keys({ ...session.counts, ...session.mentions }).sort();
		if (adapters.length === 0) {
			chips.textContent = "窗口内无派发";
			chips.classList.add("muted");
		} else {
			for (const adapter of adapters) {
				const count = session.counts[adapter] ?? 0;
				const mentions = session.mentions[adapter] ?? 0;
				const chip = document.createElement("span");
				chip.className = "acceptor-chip";
				chip.textContent = mentions > 0 ? `${adapter} ${count}(@${mentions})` : `${adapter} ${count}`;
				chip.title = `${adapter}: 窗口内 ${count} 条非 @ 派发, ${mentions} 条 @ 派发`;
				chips.appendChild(chip);
			}
		}
		countsCell.appendChild(chips);

		// ---- 证据 ----
		const evidenceCell = document.createElement("td");
		evidenceCell.className = "acceptor-evidence";
		const evidence = evidenceLines(session, snapshot);
		if (evidence.length === 0) {
			evidenceCell.textContent = "—";
		} else {
			for (const text of evidence) {
				const line = document.createElement("div");
				line.textContent = text;
				evidenceCell.appendChild(line);
			}
		}

		// ---- 冷却 ----
		const cooldownCell = document.createElement("td");
		cooldownCell.className = "num";
		cooldownCell.textContent = session.cooldownRemainingMs > 0
			? `剩余 ${fmtSpan(session.cooldownRemainingMs)}`
			: "—";
		cooldownCell.title = "冷却期内不采纳回切证据, 防止来回抖动";

		// ---- 操作 ----
		const actionCell = document.createElement("td");
		const actions = document.createElement("div");
		actions.className = "acceptor-cell-actions";

		const picker = createSelect({
			items: session.adapters.map(adapter => ({ value: adapter, label: adapter })),
			value: session.acceptor ?? "",
			onChange: (value) => { void switchTo(session, value, picker); },
		});
		if (session.adapters.length <= 1) {
			picker.el.title = "这个会话只有一个适配器派发过, 没有可切换的对象";
		}

		const resetBtn = createButton("清空", () => confirmReset(session));
		resetBtn.classList.add("danger");

		actions.append(picker.el, resetBtn);
		actionCell.appendChild(actions);

		tr.append(sessionCell, acceptorCell, countsCell, evidenceCell, cooldownCell, actionCell);
		return tr;
	}

	/** 证据行: 只列非当前受理人的挑战者与 @ 连击 */
	function evidenceLines(session, snapshot) {
		const lines = [];

		if (session.fastStreak > 0) {
			lines.push(`@ 连击 ${session.fastStreak}/${snapshot.fastPath.consecutive}`);
		}

		const challengers = Object.keys(session.scores).sort();
		for (const adapter of challengers) {
			if (adapter === session.acceptor) continue;

			const score = session.scores[adapter];
			const transfer = score?.transfer ?? 0;
			const switchBack = score?.switchBack ?? 0;
			if (transfer === 0 && switchBack === 0) continue;

			lines.push(
				`${adapter} 转移 ${transfer}/${snapshot.thresholds.transferThreshold}` +
				` · 回切 ${switchBack}/${snapshot.thresholds.switchBackThreshold}`,
			);
		}

		return lines;
	}

	async function switchTo(session, adapter, picker) {
		if (!adapter || adapter === session.acceptor) return;

		try {
			const snapshot = await callServiceAPI(SERVICE, ENDPOINT, {
				action: "override",
				botId: bot.id,
				unionId: session.unionId,
				adapter,
			});
			toast(`受理人已切到 ${adapter}`, { type: "info" });
			paint(snapshot);
		} catch (e) {
			toast(`切换失败: ${e.message}`, { type: "error" });
			picker.setValue(session.acceptor ?? "");
		}
	}

	/** 清空某个会话的受理人状态 (只需重选, 不影响业务数据) */
	function confirmReset(session) {
		const content = document.createElement("div");

		const head = document.createElement("p");
		head.textContent = "清空这个逻辑会话的受理人状态?";

		const tip = document.createElement("p");
		tip.className = "acceptor-hint muted";
		tip.textContent = "窗口计数与证据一并清零, 之后第一个从这里派发的适配器会成为受理人; 其它会话不受影响。";

		content.append(head, tip);

		const dlg = createDialogWindow("清空受理人状态", content, [
			{ name: "清空", onclick: apply, danger: true },
			{ name: "取消", onclick: () => dlg.closeDialog() },
		], { cancelable: true });

		async function apply() {
			try {
				const snapshot = await callServiceAPI(SERVICE, ENDPOINT, {
					action: "reset",
					botId: bot.id,
					unionId: session.unionId,
				});
				dlg.closeDialog();
				toast("已清空该会话的受理人状态", { type: "info" });
				paint(snapshot);
			} catch (e) {
				toast(`清空失败: ${e.message}`, { type: "error" });
			}
		}

		document.body.append(dlg);
	}

	/** 空态 / 加载中: 占满一整行, 不画一个空表头 */
	function paintEmpty(message) {
		tbody.textContent = "";

		const tr = document.createElement("tr");
		const td = document.createElement("td");
		td.colSpan = 6;
		td.className = "acceptor-empty";
		td.textContent = message;
		tr.appendChild(td);
		tbody.appendChild(tr);
	}

	function paintError(message) {
		tbody.textContent = "";

		const tr = document.createElement("tr");
		const td = document.createElement("td");
		td.colSpan = 6;
		td.className = "acceptor-error";
		td.textContent = message;
		tr.appendChild(td);
		tbody.appendChild(tr);
	}
}

/** 长 id 缩到可读长度, 完整值放 title */
function shortId(id) {
	return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** 时间戳 -> "多久以前"; 时间来自服务端快照, 避免前后端时钟不一致 */
function fmtAgo(ms, now) {
	if (!ms) return "—";

	const diff = Math.max(0, now - ms);
	if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))}s 前`;
	if (diff < 3600000) return `${Math.round(diff / 60000)}m 前`;
	if (diff < 86400000) return `${Math.round(diff / 3600000)}h 前`;
	return `${Math.round(diff / 86400000)}d 前`;
}

/** 时长 -> 紧凑写法: 45s / 4m12s / 1h05m */
function fmtSpan(ms) {
	const total = Math.max(0, Math.ceil(ms / 1000));
	if (total < 60) return `${total}s`;

	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h${String(rest).padStart(2, "0")}m` : `${hours}h`;
}
