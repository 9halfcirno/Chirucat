/**
 * 黑白名单 (单个 Bot 私有) — 过滤服务注册的 Bot 详情窗口页面
 *
 * Bot 详情窗口的子页, 只处理当前 Bot 自己的名单 —— botId 来自窗口传入的 bot,
 * 因此这里不需要 Bot 选择器。
 *
 * 模块契约(与核心的 Bot 子页一致): `render(container, bot, app)`。
 * 服务停用后这一项会从已经打开的窗口里消失, 见 js/spa/service-pages.js。
 */
import { renderFilterView } from "./filter-view.js";

export default {
	title: "名单",

	/**
	 * @param {HTMLElement} div 窗口内容容器
	 * @param {{ id: string, name?: string }} bot 当前 Bot
	 */
	render(div, bot) {
		const notice = document.createElement("p");
		notice.className = "filters-hint muted";
		notice.textContent = "这里只对当前 Bot 生效, 且优先于全局名单。";
		div.appendChild(notice);

		renderFilterView(div, { scope: "bot", botId: bot.id });
	},
};
