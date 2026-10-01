/**
 * 黑白名单视图 (过滤服务自带的前端)
 *
 * 由调用方指定范围: scope="global" 渲染全局名单; scope="bot" + botId 渲染某个
 * Bot 的私有名单。视图本身不认识任何具体 Bot —— 谁调用它, 就渲染谁的名单。
 *
 * 页面里分两块, 互不干扰:
 * - 用户名单: 按平台账号生效, 与所在会话无关
 * - 会话名单: 按群 / 频道生效 (私聊会话与用户一一对应, 由用户名单表达)
 *
 * 名单改动立即生效, 不需要重启 Bot。
 *
 * 本文件是**插件自带的前端资源**: 框架把 `services/filter/public` 挂在
 * `/service/chirucat-filter/public` 下, 页面(global.js / bot.js)与它同目录,
 * 核心前端的通用设施(api / 组件 / toast)则按绝对 URL import —— 与核心前端
 * 共用同一份模块实例。
 */
import { callServiceAPI } from "/js/spa/api.js";
import { createButton } from "/js/spa/components/button.js";
import { createDialogWindow } from "/js/spa/components/dialog-window.js";
import { createSelect } from "/js/spa/components/select.js";
import toast from "/js/spa/toast.js";

const KINDS = [
	{ value: "black", label: "黑名单" },
	{ value: "white", label: "白名单" },
];

/** 名单端点所属的服务插件 id (清单里的 id) */
const FILTER_SERVICE = "chirucat-filter";
/** 该服务注册的端点名 */
const FILTER_ENDPOINT = "filter_list";

const KIND_NAMES = { black: "黑名单", white: "白名单" };

/** 会话名单只覆盖群与频道 */
const SESSION_TYPES = [
	{ value: "group", label: "群" },
	{ value: "channel", label: "频道" },
];

const SESSION_NAMES = { group: "群", channel: "频道" };

/**
 * 渲染一份名单 (两块: 用户 / 会话)
 *
 * @param {HTMLElement} div 容器, 会被加上 filters-page 类
 * @param {{ scope: "global" | "bot", botId?: string }} options
 */
export function renderFilterView(div, { scope, botId = "" }) {
	div.classList.add("filters-page");

	const userBlock = createBlock({ scope, botId, targetType: "user", onChanged: () => load() });
	const sessionBlock = createBlock({ scope, botId, targetType: "session", onChanged: () => load() });
	div.append(userBlock.section, sessionBlock.section);

	async function load() {
		try {
			const data = await callServiceAPI(FILTER_SERVICE, FILTER_ENDPOINT, { action: "list", scope, botId });
			const entries = data.entries ?? [];
			userBlock.setEntries(entries.filter(entry => entry.targetType !== "session"));
			sessionBlock.setEntries(entries.filter(entry => entry.targetType === "session"));
		} catch (e) {
			userBlock.setError(e.message);
			sessionBlock.setError(e.message);
		}
	}

	void load();
}

/**
 * 一块名单 (用户或会话) 的卡片: 添加表单 + 列表
 *
 * @param {{
 *   scope: "global" | "bot",
 *   botId: string,
 *   targetType: "user" | "session",
 *   onChanged: () => void,
 * }} options
 */
function createBlock({ scope, botId, targetType, onChanged }) {
	const isSession = targetType === "session";

	const section = document.createElement("section");
	section.className = "card glass filters-card";

	const title = document.createElement("h3");
	title.textContent = isSession ? "会话名单" : "用户名单";

	const desc = document.createElement("p");
	desc.className = "filters-hint muted";
	desc.textContent = isSession
		? "按群 / 频道生效; 私聊会话与用户一一对应, 请用用户名单表达。"
		: "按平台账号生效, 与其所在会话无关。";

	// ---- 添加表单 ----
	const kindSelect = createSelect({ items: KINDS, value: "black" });
	const sessionTypeSelect = createSelect({ items: SESSION_TYPES, value: "group" });
	const platformInput = createInput("如 qq / onebot11");
	const idInput = createInput(isSession ? "会话ID" : "平台用户ID");
	const reasonInput = createInput("备注 (可选)");

	const addBtn = createButton("加入名单", () => doAdd());
	addBtn.classList.add("primary");

	const fields = [createField("名单类型", kindSelect.el)];
	if (isSession) fields.push(createField("会话类型", sessionTypeSelect.el));
	fields.push(
		createField("平台", platformInput),
		createField("平台ID", idInput),
		createField("备注", reasonInput),
		addBtn,
	);

	const form = document.createElement("div");
	form.className = "filters-form";
	form.append(...fields);

	// ---- 列表 ----
	const summary = document.createElement("p");
	summary.className = "filters-hint muted";
	summary.textContent = "加载中…";

	const tableWrap = document.createElement("div");
	tableWrap.className = "filters-table-wrap";

	const table = document.createElement("table");
	table.className = "filters-table";

	const columnCount = 7;
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	const secondColumn = isSession ? "对象" : "昵称";
	for (const text of ["类型", secondColumn, "平台", isSession ? "会话ID" : "平台ID", "备注", "加入时间", ""]) {
		const th = document.createElement("th");
		th.textContent = text;
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);

	const tbody = document.createElement("tbody");
	table.append(thead, tbody);
	tableWrap.appendChild(table);

	section.append(title, desc, form, summary, tableWrap);

	async function doAdd() {
		const platform = platformInput.value.trim();
		const id = idInput.value.trim();
		if (!platform || !id) {
			toast("请填写平台与平台ID", { type: "warn" });
			return;
		}

		const kind = kindSelect.getValue();
		const target = { platform, id };
		if (isSession) target.type = sessionTypeSelect.getValue();

		try {
			await callServiceAPI(FILTER_SERVICE, FILTER_ENDPOINT, {
				action: "add",
				scope,
				botId,
				kind,
				targetType,
				target,
				reason: reasonInput.value.trim(),
			});
			toast(`已加入${KIND_NAMES[kind] ?? kind}`, { type: "info" });
			idInput.value = "";
			reasonInput.value = "";
			onChanged();
		} catch (e) {
			toast(`添加失败: ${e.message}`, { type: "error" });
		}
	}

	function confirmRemove(entry) {
		const content = document.createElement("div");

		const head = document.createElement("p");
		const who = document.createElement("strong");
		who.textContent = isSession
			? `${SESSION_NAMES[entry.sessionType] ?? "会话"} ${entry.platformId || entry.target}`
			: (entry.name || entry.platformId || entry.target);
		head.append("把 ", who, ` 从${KIND_NAMES[entry.kind] ?? entry.kind}中移除?`);

		const tip = document.createElement("p");
		tip.className = "filters-hint muted";
		tip.textContent = "移除后立即恢复通行, 不需要重启。";

		content.append(head, tip);

		const dlg = createDialogWindow("确认移除", content, [
			{ name: "移除", onclick: apply, danger: true },
			{ name: "取消", onclick: () => dlg.closeDialog() },
		], { cancelable: true });

		async function apply() {
			try {
				await callServiceAPI(FILTER_SERVICE, FILTER_ENDPOINT, { action: "remove", scope, botId, id: entry.id });
				dlg.closeDialog();
				toast("已从名单移除", { type: "info" });
				onChanged();
			} catch (e) {
				toast(`移除失败: ${e.message}`, { type: "error" });
			}
		}

		document.body.append(dlg);
	}

	/** 用一组条目刷新列表 */
	function setEntries(entries) {
		tbody.textContent = "";
		summary.textContent = entries.length === 0
			? "名单为空, 当前没有这类拦截规则"
			: `共 ${entries.length} 项`;

		for (const entry of entries) {
			const tr = document.createElement("tr");

			const kind = document.createElement("td");
			const badge = document.createElement("span");
			badge.className = `filters-badge ${entry.kind}`;
			badge.textContent = KIND_NAMES[entry.kind] ?? entry.kind;
			kind.appendChild(badge);

			// 第二列: 会话显示对象类型, 用户显示昵称
			const second = document.createElement("td");
			if (isSession) {
				const objBadge = document.createElement("span");
				objBadge.className = "filters-badge object";
				objBadge.textContent = SESSION_NAMES[entry.sessionType] ?? "会话";
				second.appendChild(objBadge);
			} else {
				second.textContent = entry.name || "—";
			}

			const platform = document.createElement("td");
			platform.textContent = entry.platform || "—";

			const pid = document.createElement("td");
			pid.className = "mono";
			pid.textContent = entry.platformId || "—";
			pid.title = entry.target;

			const reason = document.createElement("td");
			reason.textContent = entry.reason || "—";

			const time = document.createElement("td");
			time.className = "num";
			time.textContent = fmtTime(entry.createdAt);

			const action = document.createElement("td");
			const delBtn = createButton("移除", () => confirmRemove(entry));
			delBtn.classList.add("danger");
			action.appendChild(delBtn);

			tr.append(kind, second, platform, pid, reason, time, action);
			tbody.appendChild(tr);
		}
	}

	/** 拉取失败时在列表里显示原因 */
	function setError(message) {
		tbody.textContent = "";
		summary.textContent = "";

		const tr = document.createElement("tr");
		const td = document.createElement("td");
		td.colSpan = columnCount;
		td.className = "filters-error";
		td.textContent = message;
		tr.appendChild(td);
		tbody.appendChild(tr);
	}

	return { section, setEntries, setError };
}

/** 带标签的字段 */
function createField(label, control) {
	const wrap = document.createElement("label");
	wrap.className = "filters-field";

	const name = document.createElement("span");
	name.className = "filters-field-label";
	name.textContent = label;

	wrap.append(name, control);
	return wrap;
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

/** 时间戳 -> 本地短时间 */
function fmtTime(ms) {
	if (!ms) return "—";
	return new Date(ms).toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}
