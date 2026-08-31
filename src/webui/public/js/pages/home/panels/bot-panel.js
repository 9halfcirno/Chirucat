/**
 * 首页仪表盘: 机器人板块
 *
 * 运行数 + 每个 bot 的状态点列表 (不用占用条)。
 */
import { createPanel } from "../widgets.js";

/** 机器人板块: 运行数 + 每个 bot 的状态点列表 (不用占用条) */
export function createBotPanel() {
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
