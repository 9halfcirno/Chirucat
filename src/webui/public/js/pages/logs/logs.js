/**
 * 日志查看页面 (占位)
 *
 * TODO: 接入后端日志接口 (轮询或 WebSocket 推送)。
 */
export default {
	id: "logs",
	title: "日志",
	icon: "📋",

	render(container) {
		container.innerHTML = `
			<h1>日志</h1>
			<p class="muted">查看运行日志 (开发中)</p>
			<div class="card">
				<p>暂无日志</p>
			</div>
			<p class="muted">TODO: 实时日志流</p>
		`;
	},
};
