/**
 * 设置页面 (占位)
 *
 * TODO: 接入 WebUI 及框架的配置读写接口。
 */
export default {
	id: "settings",
	title: "设置",
	icon: "⚙️",

	render(container) {
		container.innerHTML = `
			<h1>设置</h1>
			<p class="muted">WebUI 与框架配置 (开发中)</p>
			<p class="muted">TODO: 主题、语言、端口等</p>
		`;
	},
};
