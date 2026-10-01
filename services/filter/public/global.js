/**
 * 黑白名单 (全局) — 过滤服务注册的一级导航页面
 *
 * 本页只负责对所有 Bot 生效的全局名单; 单个 Bot 的私有名单是本插件注册的
 * **Bot 详情窗口页面**(见 bot.js), 由那个窗口把它挂在 Bot 信息旁边。
 *
 * 两层的判定关系见 filter-judge.ts: 都要放行才通过, 因此 Bot 私有的名单
 * 实际优先级更高。
 *
 * 模块契约(与核心页面一致): 默认导出 `{ render(container, app) }`。
 */
import { renderFilterView } from "./filter-view.js";

export default {
	title: "黑白名单",

	/**
	 * @param {HTMLDivElement} div 页面容器
	 */
	render(div) {
		const notice = document.createElement("p");
		notice.className = "filters-hint muted";
		notice.textContent = "这里是对所有 Bot 生效的全局名单; 单个 Bot 自己的名单在「机器人」页打开 Bot 详情后配置。";
		div.appendChild(notice);

		renderFilterView(div, { scope: "global" });
	},
};
