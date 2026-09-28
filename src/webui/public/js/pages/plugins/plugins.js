/**
 * 插件页 · 服务插件管理
 *
 * 一级页面 plugins 的二级菜单之一(见下方 sidebar)。管理的是 services/ 下的
 * 框架级插件: 它们不归属任何 Bot, 由核心加载, 因此这里不涉及 Bot 启停 ——
 * 只要核心在, 服务插件随时可启停, 配置值也是全局唯一的
 * (configs/services/<插件id>.json)。
 *
 * 卡片与配置弹窗复用 spa/components/plugin-card.js, 与 Bot 面板的插件页同一套
 * 外观; 该文件的样式类(plugin 与 bot-page 两组)定义在 bot 面板的样式表里, 因此
 * 这里按原样加载它, 而不是复制一份样式。
 */
import { renderServices } from "./pages/service.js";

export default {
	id: "plugins",
	title: "插件",
	styles: ["/js/pages/bots/bot-div.css"],

	render(container) { },

	sidebar: [{
		title: "服务",
		render(div) {
			renderServices(div)
		}
	}, {
		title: "市场",
		render(div) {
			div.textContent = "敬请期待..."
		}
	}]
};

