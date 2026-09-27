import { renderOverviewPage } from "./sub-pages/overview.js"
import { renderListPage } from "./sub-pages/list.js"
import { renderQueryPage } from "./sub-pages/query.js"

export default {
	id: "users",
	title: "用户管理",
	icon: "/img/icons/user.svg",
	styles: ["/js/pages/users/users.css"],

	/** 页面骨架留给二级菜单使用, 本页自身不渲染内容
	 * @param {HTMLDivElement} div 
	 */
	render(div) { },

	sidebar: [{
		title: "概览",
		render: renderOverviewPage
	}, {
		title: "列表",
		render: renderListPage
	}, {
		title: "管理",
		render: renderQueryPage
	},]
}