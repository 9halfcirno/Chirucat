/**
 * 用户管理 — 列表
 *
 * 分页浏览全部账号, 支持按平台 / 关键字 / 绑定状态筛选。
 * 昵称与活跃数据由后端对当前页的账号批量补齐 (内部库与统计库无法联表,
 * 只能先分页再聚合), 因此活跃列仅覆盖统计明细保留期内的数据。
 *
 * 本页只读; 绑定与解绑在「管理」子页完成。
 */
import { createSelect } from "../../../spa/components/select.js";
import { callAPI, fmt, fmtTime, shortId } from "../user-api.js";

/** 每页条数 */
const PAGE_SIZE = 20;

const BOUND_OPTIONS = [
	{ value: "all", label: "全部" },
	{ value: "bound", label: "已绑定" },
	{ value: "single", label: "独立账号" },
];

/**
 * @param {HTMLDivElement} div
*/
export function renderListPage(div) {
	div.classList.add("users-manage");

	/** 当前筛选与分页状态 */
	const state = { platform: "", keyword: "", bound: "all", offset: 0, days: 7 };
	let total = 0;

	// ---- 筛选栏 ----
	const filterBar = document.createElement("div");
	filterBar.className = "card glass users-card users-filters";

	const platformField = createInput("平台", "如 qq / onebot11");
	const keywordField = createInput("关键字", "平台用户ID 或 账号ID");

	const boundLabel = document.createElement("label");
	boundLabel.className = "users-field";
	const boundName = document.createElement("span");
	boundName.className = "users-field-label";
	boundName.textContent = "绑定状态";
	const boundSelect = createSelect({
		items: BOUND_OPTIONS,
		value: state.bound,
		onChange: (value) => {
			state.bound = value;
		},
	});
	boundLabel.append(boundName, boundSelect.el);

	const searchBtn = document.createElement("button");
	searchBtn.type = "button";
	searchBtn.className = "btn primary";
	searchBtn.textContent = "查询";
	searchBtn.addEventListener("click", () => applyFilter());

	const resetBtn = document.createElement("button");
	resetBtn.type = "button";
	resetBtn.className = "btn";
	resetBtn.textContent = "重置";
	resetBtn.addEventListener("click", () => {
		platformField.input.value = "";
		keywordField.input.value = "";
		boundSelect.setValue("all");
		state.bound = "all";
		applyFilter();
	});

	// 回车即查询
	for (const field of [platformField, keywordField]) {
		field.input.addEventListener("keydown", e => {
			if (e.key === "Enter") applyFilter();
		});
	}

	filterBar.append(platformField.wrap, keywordField.wrap, boundLabel, searchBtn, resetBtn);
	div.appendChild(filterBar);

	// ---- 汇总与表格 ----
	const summary = document.createElement("p");
	summary.className = "users-hint muted";
	div.appendChild(summary);

	const tableWrap = document.createElement("div");
	tableWrap.className = "card glass users-card users-table-wrap";

	const table = document.createElement("table");
	table.className = "users-table";

	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const text of ["昵称", "平台", "平台ID", "账号ID", "跨平台ID", "组内", "近7天消息", "最后活跃"]) {
		const th = document.createElement("th");
		th.textContent = text;
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);

	const tbody = document.createElement("tbody");
	table.append(thead, tbody);
	tableWrap.appendChild(table);
	div.appendChild(tableWrap);

	// ---- 分页 ----
	const pager = document.createElement("div");
	pager.className = "users-actions";

	const prevBtn = document.createElement("button");
	prevBtn.type = "button";
	prevBtn.className = "btn";
	prevBtn.textContent = "上一页";
	prevBtn.addEventListener("click", () => turn(-1));

	const nextBtn = document.createElement("button");
	nextBtn.type = "button";
	nextBtn.className = "btn";
	nextBtn.textContent = "下一页";
	nextBtn.addEventListener("click", () => turn(1));

	const pageInfo = document.createElement("span");
	pageInfo.className = "users-hint muted";

	pager.append(prevBtn, nextBtn, pageInfo);
	div.appendChild(pager);

	/** 应用筛选条件并回到第一页 */
	function applyFilter() {
		state.platform = platformField.input.value.trim();
		state.keyword = keywordField.input.value.trim();
		state.bound = boundSelect.getValue();
		state.offset = 0;
		load();
	}

	/** 翻页 */
	function turn(direction) {
		const next = state.offset + direction * PAGE_SIZE;
		if (next < 0 || next >= total) return;
		state.offset = next;
		load();
	}

	/** 渲染一页数据 */
	function renderItems(items) {
		tbody.textContent = "";

		if (items.length === 0) {
			const tr = document.createElement("tr");
			const td = document.createElement("td");
			td.colSpan = 8;
			td.className = "users-empty";
			td.textContent = "没有符合条件的账号";
			tr.appendChild(td);
			tbody.appendChild(tr);
			return;
		}

		for (const item of items) {
			const tr = document.createElement("tr");

			const name = document.createElement("td");
			name.textContent = item.name || "-";

			const platform = document.createElement("td");
			platform.textContent = item.platform;

			const pid = document.createElement("td");
			pid.className = "mono truncate";
			pid.textContent = item.id;
			pid.title = item.id;

			const aid = document.createElement("td");
			aid.className = "mono";
			aid.textContent = shortId(item.accountId);
			aid.title = item.accountId;

			const uid = document.createElement("td");
			uid.className = "mono";
			uid.textContent = shortId(item.unionId);
			uid.title = item.unionId;

			const size = document.createElement("td");
			size.className = "num";
			size.textContent = String(item.unionSize);

			const msgs = document.createElement("td");
			msgs.className = "num";
			msgs.textContent = item.activity ? fmt(item.activity.count) : "-";

			const last = document.createElement("td");
			last.className = "num";
			last.textContent = item.activity ? fmtTime(item.activity.lastTime) : "-";

			tr.append(name, platform, pid, aid, uid, size, msgs, last);
			tbody.appendChild(tr);
		}
	}

	async function load() {
		summary.textContent = "加载中…";
		try {
			const data = await callAPI("list_users", {
				platform: state.platform,
				keyword: state.keyword,
				bound: state.bound,
				limit: PAGE_SIZE,
				offset: state.offset,
				days: state.days,
			});

			total = data.total;
			renderItems(data.items);

			const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
			const page = Math.floor(state.offset / PAGE_SIZE) + 1;
			pageInfo.textContent = data.statisticsEnabled
				? `第 ${page} / ${pageCount} 页`
				: `第 ${page} / ${pageCount} 页（统计模块未启用, 活跃列为空）`;
			summary.textContent = `共 ${fmt(total)} 个账号`;

			prevBtn.disabled = state.offset === 0;
			nextBtn.disabled = state.offset + PAGE_SIZE >= total;
		} catch (e) {
			total = 0;
			tbody.textContent = "";
			const tr = document.createElement("tr");
			const td = document.createElement("td");
			td.colSpan = 8;
			td.className = "users-error";
			td.textContent = e.message;
			tr.appendChild(td);
			tbody.appendChild(tr);
			summary.textContent = "";
			pageInfo.textContent = "";
			prevBtn.disabled = true;
			nextBtn.disabled = true;
		}
	}

	/** 一个带标签的输入框 */
	function createInput(label, placeholder) {
		const wrap = document.createElement("label");
		wrap.className = "users-field";

		const name = document.createElement("span");
		name.className = "users-field-label";
		name.textContent = label;

		const input = document.createElement("input");
		input.className = "input";
		input.type = "text";
		input.autocomplete = "off";
		input.spellcheck = false;
		if (placeholder) input.placeholder = placeholder;

		wrap.append(name, input);
		return { wrap, input };
	}

	load();
}
