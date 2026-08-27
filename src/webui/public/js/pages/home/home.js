/**
 * 首页: 仪表盘
 *
 * 真实请求后端 /api/health 检查服务器状态, 并定时刷新。
 * 首次刷新在加载遮罩内完成, 用于展示"等待页面加载"的过程。
 */
let refreshTimer = null;

export default {
	id: "home",
	title: "首页",
	icon: "🏠",
	styles: ["/js/pages/home/home.css"],

	async render(container) {
		const h1 = document.createElement("h1");
		h1.textContent = "Chirucat WebUI";

		const status = document.createElement("p");
		status.id = "status";
		status.textContent = "正在检查服务器状态...";

		const tip = document.createElement("p");
		tip.className = "muted";
		tip.textContent = "使用左侧导航切换页面";

		container.append(h1, status, tip);

		const refresh = async () => {
			try {
				const res = await fetch("/api/health");
				const data = await res.json();
				const ok = data.status === "ok";
				status.textContent = `服务器状态: ${data.status} (${new Date(data.time).toLocaleString()})`;
				status.classList.toggle("ok", ok);
				status.classList.toggle("bad", !ok);
			} catch (err) {
				status.textContent = `无法连接服务器: ${err.message}`;
				status.classList.add("bad");
				status.classList.remove("ok");
			}
		};

		await refresh();
		refreshTimer = setInterval(refresh, 10_000);
	},

	destroy() {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	},
};
