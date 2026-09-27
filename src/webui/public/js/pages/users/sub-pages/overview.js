/**
 * 用户管理 — 概览
 *
 * 账号与跨平台ID 的规模统计, 以及近 N 天活跃账号数。
 * 规模数据来自内部库, 活跃数据来自统计库 (仅明细保留期内可得)。
 */
import { callAPI, fmt } from "../user-api.js";

const RANGES = [
	{ label: "24 小时", days: 1 },
	{ label: "7 天", days: 7 },
	{ label: "30 天", days: 30 },
];

/**
 * @param {HTMLDivElement} div
*/
export function renderOverviewPage(div) {
	div.classList.add("users-manage");

	let current = RANGES[1];

	// ---- 活跃统计的时间范围 ----
	const bar = document.createElement("div");
	bar.className = "users-ranges";

	const buttons = RANGES.map(range => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "users-range";
		btn.textContent = range.label;
		btn.addEventListener("click", () => {
			if (current === range) return;
			current = range;
			syncButtons();
			refresh();
		});
		bar.appendChild(btn);
		return { range, btn };
	});

	const syncButtons = () => {
		for (const { range, btn } of buttons) btn.classList.toggle("active", range === current);
	};
	syncButtons();

	div.appendChild(bar);

	// ---- 卡片与说明 ----
	const cards = document.createElement("div");
	cards.className = "users-cards";
	div.appendChild(cards);

	const legend = document.createElement("p");
	legend.className = "users-hint muted";
	legend.textContent = "这里的「用户」指一个跨平台身份, 可以包含同一人在多个平台上的账号。";
	div.appendChild(legend);

	const notice = document.createElement("p");
	notice.className = "users-hint muted";
	notice.hidden = true;
	div.appendChild(notice);

	// ---- 平台分布 ----
	const platformCard = document.createElement("section");
	platformCard.className = "card glass users-card";

	const platformTitle = document.createElement("h3");
	platformTitle.textContent = "平台分布";

	const platformList = document.createElement("div");
	platformList.className = "users-bars";

	platformCard.append(platformTitle, platformList);
	div.appendChild(platformCard);

	/** 渲染概览卡片 */
	function renderCards(data) {
		const items = [
			{ label: "账号总数", value: data.accounts },
			{ label: "用户总数", value: data.unions },
			{ label: "多平台用户", value: data.boundUnions },
			{ label: "单平台用户", value: data.singleAccounts },
			{ label: `近 ${data.days} 天活跃`, value: data.statisticsEnabled ? data.activeAccounts : null },
		];

		cards.textContent = "";
		for (const item of items) {
			const card = document.createElement("div");
			card.className = "users-stat-card";

			const value = document.createElement("div");
			value.className = "users-stat-value";
			value.textContent = item.value === null ? "-" : fmt(item.value);

			const label = document.createElement("div");
			label.className = "users-stat-label";
			label.textContent = item.label;

			card.append(value, label);
			cards.appendChild(card);
		}
	}

	/** 渲染平台分布条形列表 */
	function renderPlatforms(list) {
		platformList.textContent = "";

		if (!list || list.length === 0) {
			const empty = document.createElement("p");
			empty.className = "users-empty";
			empty.textContent = "暂无数据";
			platformList.appendChild(empty);
			return;
		}

		const max = Math.max(...list.map(p => p.accounts), 1);
		for (const item of list) {
			const row = document.createElement("div");
			row.className = "users-bar-row";

			const name = document.createElement("span");
			name.className = "users-bar-name";
			name.textContent = item.platform;

			const track = document.createElement("div");
			track.className = "users-bar-track";
			const fill = document.createElement("div");
			fill.className = "users-bar-fill";
			fill.style.width = `${(item.accounts / max) * 100}%`;
			track.appendChild(fill);

			const count = document.createElement("span");
			count.className = "users-bar-count";
			count.textContent = fmt(item.accounts);

			row.append(name, track, count);
			platformList.appendChild(row);
		}
	}

	async function refresh() {
		try {
			const data = await callAPI("get_user_overview", { days: current.days });
			renderCards(data);
			renderPlatforms(data.platforms);

			if (!data.statisticsEnabled) {
				notice.hidden = false;
				notice.textContent = "统计模块未启用, 活跃账号数不可用。";
			} else if (data.partial) {
				notice.hidden = false;
				notice.textContent = "统计范围超出明细保留期, 活跃账号数为不完整值。";
			} else {
				notice.hidden = true;
			}
		} catch (e) {
			cards.textContent = "";
			platformList.textContent = "";
			notice.hidden = true;

			const err = document.createElement("p");
			err.className = "users-error";
			err.textContent = e.message;
			cards.appendChild(err);
		}
	}

	refresh();
}
