/**
 * 机器人管理页面 (占位)
 *
 * TODO: 接入后端机器人的列表/启停等真实接口。
 * 当前用 setTimeout 模拟异步请求, 用于演示加载遮罩。
 */
export default {
	id: "bots",
	title: "机器人",
	icon: "🤖",

	async render(container) {
		// 模拟异步请求, 让加载遮罩可见
		await new Promise((resolve) => setTimeout(resolve, 600));

		container.innerHTML = `
			<h1>机器人</h1>
			<p class="muted">管理机器人实例 (开发中)</p>
			<div class="card">
				<h3>bots/chirucat</h3>
				<p>状态: 已启用</p>
			</div>
			<p class="muted">TODO: 列出 / 启动 / 停止机器人</p>
		`;
	},
};
