/**
 * 黑白名单 (单个 Bot 私有)
 *
 * Bot 详情弹窗的子页, 只处理当前 Bot 自己的名单 —— botId 来自弹窗传入的 bot,
 * 因此这里不需要 Bot 选择器。
 */
import { renderFilterView } from "../../filters/filter-view.js";

export default {
	icon: "/img/icons/shield.svg",
	title: "名单",
	styles: ["/js/pages/filters/filters.css"],

	/**
	 * @param {HTMLElement} div
	 * @param {{ id: string, name?: string }} bot
	 */
	render(div, bot) {
		const notice = document.createElement("p");
		notice.className = "filters-hint muted";
		notice.textContent = "这里只对当前 Bot 生效, 且优先于全局名单。";
		div.appendChild(notice);

		renderFilterView(div, { scope: "bot", botId: bot.id });
	},
};
