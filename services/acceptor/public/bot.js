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
/** 输入停顿多久才去查 (逐字查会把每个按键都变成一次请求) */
const SEARCH_DEBOUNCE_MS = 300;
/** 可选的每页条数 */
const PAGE_SIZES = [20, 50, 100];
/** 首次加载的每页条数 (与后端默认值一致) */
const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];

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

	// ---- 查询与分页 ----
	// 群可能上千: 表格只画当前页, 其余靠 offset/limit 翻, 搜索走服务端过滤。
	/**
	 * 当前视图 (查询 + 分页)
	 *
	 * 所有请求都带上它: 换人/清空之后也要停在同一边, 否则操作一下就被踢回第一页。
	 * 服务端会回它实际用的值(`offset` 可能被夹到最后一页), 这里再同步回来。
	 *
	 * 写在控件之前: 控件的 onChange 闭包引用它, 提前声明才不会撞上 TDZ。
	 */
	const view = { query: "", offset: 0, limit: DEFAULT_PAGE_SIZE };
	/** 上次拿到的过滤后总数; 翻页按钮靠它判边界 */
	let totalSessions = 0;

	const searchInput = createInput("搜 unionId / 群号 / 适配器");
	searchInput.classList.add("acceptor-search");
	searchInput.type = "search";

	const pageSizeSelect = createSelect({
		items: PAGE_SIZES.map(size => ({ value: String(size), label: `每页 ${size} 条` })),
		value: String(DEFAULT_PAGE_SIZE),
		onChange: (value) => {
			view.limit = Number(value) || DEFAULT_PAGE_SIZE;
			view.offset = 0; // 换了条数还停在旧 offset 上会跳到“空气页”
			void load();
		},
	});

	const prevBtn = createButton("上一页", () => {
		if (view.offset <= 0) return; // 已在第一页: 不白跑一次请求
		view.offset = Math.max(0, view.offset - view.limit);
		void load();
	});

	const nextBtn = createButton("下一页", () => {
		// 边界由 paintPager 维护的 total 决定: 越界时不请求 (服务端会夹回去, 但白跑一趟)
		if (view.offset + view.limit >= totalSessions) return;
		view.offset += view.limit;
		void load();
	});

	const pageInfo = document.createElement("span");
	pageInfo.className = "acceptor-pageinfo muted";

	const toolbar = document.createElement("div");
	toolbar.className = "acceptor-toolbar";
	const toolbarSpacer = document.createElement("span");
	toolbarSpacer.className = "acceptor-spacer";
	toolbar.append(searchInput, toolbarSpacer, pageSizeSelect.el, prevBtn, nextBtn);

	const footer = document.createElement("div");
	footer.className = "acceptor-footer";
	footer.append(pageInfo);

	const tableCard = document.createElement("section");
	tableCard.className = "card glass acceptor-card";
	tableCard.append(tableHeadRow, toolbar, tableWrap, footer);

	div.append(headCard, tableCard);

	// 搜索: 停顿 300ms 才发请求, 逐字查会把每个按键都变成一次请求
	let searchTimer = null;
	searchInput.addEventListener("input", () => {
		if (searchTimer !== null) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchTimer = null;
			const next = searchInput.value.trim();
			if (next === view.query) return;
			view.query = next;
			view.offset = 0; // 换了关键字还停在旧页码上没有意义
			void load();
		}, SEARCH_DEBOUNCE_MS);
	});

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

	/** 把当前视图带进请求体 (三种 action 共用) */
	function payload(action, extra = {}) {
		return {
			action,
			botId: bot.id,
			query: view.query,
			offset: view.offset,
			limit: view.limit,
			...extra,
		};
	}

	async function load() {
		try {
			const snapshot = await callServiceAPI(SERVICE, ENDPOINT, payload("state"));
			paint(snapshot);
		} catch (e) {
			paintError(`读取受理人状态失败: ${e.message}`);
		}
	}

	/** 用一份快照刷新整页 */
	function paint(snapshot) {
		// 同步服务端实际用的分页位置: offset 越界时它会把我们夹回最后一页
		if (snapshot.page) {
			view.query = snapshot.page.query ?? view.query;
			view.offset = snapshot.page.offset ?? view.offset;
			view.limit = snapshot.page.limit ?? view.limit;
			// `value` 在 DOM 桩里可能是 undefined, 取一次当前值再比
			if ((searchInput.value ?? "").trim() !== view.query) searchInput.value = view.query;
		}

		paintHead(snapshot);
		paintTable(snapshot);
		paintPager(snapshot);
		updated.textContent = `更新于 ${new Date(snapshot.now).toLocaleTimeString("zh-CN")}`;
	}

	/** 页码 / 上一页 / 下一页 / 总数 */
	function paintPager(snapshot) {
		const page = snapshot.page ?? { total: snapshot.sessions.length, offset: 0, limit: view.limit };
		totalSessions = page.total;

		const pages = Math.max(1, Math.ceil(page.total / page.limit));
		const current = Math.floor(page.offset / page.limit) + 1;

		// 总是显示总数: 空列表也要能区分“真的什么都没有”与“搜索没命中”
		const parts = [`共 ${page.total} 个会话`];
		if (page.total > 0) parts.push(`第 ${current} / ${pages} 页`);
		if (view.query) parts.push(`筛选: “${view.query}”`);
		pageInfo.textContent = parts.join(" · ");

		// 用 class 而不是 `disabled`: `createButton` 的 onclick 在 finally 里会把
		// `disabled` 重置成 false, 直接设属性会被它覆盖。
		markPagerButton(prevBtn, page.offset > 0);
		markPagerButton(nextBtn, page.offset + page.limit < page.total);
	}

	/** 给翻页按钮标可用/不可用 (视觉 + 无障碍, 不靠 `disabled` 属性) */
	function markPagerButton(button, enabled) {
		button.classList.toggle("acceptor-disabled", !enabled);
		button.setAttribute("aria-disabled", enabled ? "false" : "true");
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
			modeHint.textContent =
				"每个逻辑会话只放行受理人的消息, 其余适配器的派发会被拦下。日常状态看这页就好 —— 正式模式不会往日志里刷周期汇总, 只在受理人变更时记一条。";
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
			// 搜索无命中与真的没有会话是两回事, 文案得说清是哪种
			if (view.query) {
				paintEmpty(`没有会话匹配 “${view.query}”。`);
				return;
			}

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
			// 窗口内静默: 受理人不会因此改变, 但把“上次什么时候说过话”列出来
			// 比一句“无派发”有用 —— 排障时常用的就是这一点。
			const historic = Object.keys(session.lastProbeAt ?? {}).sort();
			if (historic.length === 0) {
				chips.textContent = "窗口内无派发";
				chips.classList.add("muted");
			} else {
				for (const adapter of historic) {
					const chip = document.createElement("span");
					chip.className = "acceptor-chip quiet";
					chip.textContent = `${adapter} · 上次 ${fmtAgo(session.lastProbeAt[adapter], snapshot.now)}`;
					chip.title = "窗口内已无派发; 受理人保持不变";
					chips.appendChild(chip);
				}
			}
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
			const snapshot = await callServiceAPI(SERVICE, ENDPOINT, payload("override", {
				unionId: session.unionId,
				adapter,
			}));
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
				const snapshot = await callServiceAPI(SERVICE, ENDPOINT, payload("reset", {
					unionId: session.unionId,
				}));
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

/** 文本输入框 */
function createInput(placeholder) {
	const input = document.createElement("input");
	input.className = "input";
	input.type = "text";
	input.autocomplete = "off";
	input.spellcheck = false;
	if (placeholder) input.placeholder = placeholder;
	return input;
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
