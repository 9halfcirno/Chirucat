/**
 * 黑白名单 (全局)
 *
 * 本页只负责对所有 Bot 生效的全局名单; 单个 Bot 的私有名单是「机器人」页里
 * Bot 详情弹窗的子页 (见 pages/bots/bot-pages/filter.js), 由它自己带上 botId。
 *
 * 两层的判定关系见 bot/message-handler.ts: 都要放行才通过, 因此 Bot 私有的
 * 名单实际优先级更高。
 */
import { renderFilterView } from "./filter-view.js";

export default {
	id: "filters",
	title: "黑白名单",
	icon: "/img/icons/shield.svg",
	styles: ["/js/pages/filters/filters.css"],

	/**
	 * @param {HTMLDivElement} div
	 */
	render(div) {
		const notice = document.createElement("p");
		notice.className = "filters-hint muted";
		notice.textContent = "这里是对所有 Bot 生效的全局名单; 单个 Bot 自己的名单在「机器人」页打开 Bot 详情后配置。";
		div.appendChild(notice);

		renderFilterView(div, { scope: "global" });
	},
};
