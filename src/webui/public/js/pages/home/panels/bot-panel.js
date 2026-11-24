/**
 * 首页: 机器人板块
 *
 * 左边一个「运行中 / 总数」的计数, 右边是 bot 列表 (状态点 + 名称 + id),
 * 与字符画一致: 计数在左侧竖排居中, 列表逐行往下排。
 *
 * 刷新是增量的: 已有的 <li> 复用, 只有新增 / 删除 / 顺序变化才动 DOM。
 */
import { createPanel } from "../widgets.js";

export function createBotPanel() {
	const { section, body } = createPanel("机器人");
	body.classList.add("bot-body");

	// 计数: 左侧栏, 纵向居中于列表 (字符画里 2 / 3 与列表同高)
	const count = document.createElement("div");
	count.className = "bot-count";

	const countValue = document.createElement("span");
	countValue.className = "bot-count-value";
	countValue.textContent = "-";

	const countLabel = document.createElement("span");
	countLabel.className = "bot-count-label";
	countLabel.textContent = "运行中 / 总数";

	count.append(countValue, countLabel);

	// bot 列表: 运行中的排前面, 再按 id 排序
	const list = document.createElement("ul");
	list.className = "bot-state-list";

	body.append(count, list);

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

	const clearItems = () => {
		for (const li of itemMap.values()) li.remove();
		itemMap.clear();
	};

	const update = (state) => {
		const core = state.core;

		if (!core) {
			// WebUI 独立运行: 清空列表, 只保留提示
			countValue.textContent = "- / -";
			clearItems();
			showEmpty("WebUI 独立运行, 未连接核心");
			return;
		}

		countValue.textContent = `${core.runningBotCount} / ${core.botCount}`;

		const bots = (core.bots ?? [])
			.slice()
			.sort((a, b) => (b.running - a.running) || a.id.localeCompare(b.id));

		if (bots.length === 0) {
			clearItems();
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
