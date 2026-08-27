/**
 * 机器人管理页面
 *
 * 调用后端 GET /api/get_bot_list 获取机器人列表, 以卡片形式展示。
 * 卡片容器使用 flex 布局 (见 layout.css 的 .bot-list)。
 */
export default {
	id: "bots",
	title: "机器人",
	icon: "🤖",
	styles: ["/js/pages/bots/bots.css"],

	async render(container) {
		const h1 = document.createElement("div");
		h1.textContent = "机器人";

		const tip = document.createElement("p");
		tip.className = "muted";
		tip.textContent = "管理机器人实例";

		container.append(h1, tip);

		// bot 卡片容器: flex 布局, 卡片自动换行
		const list = document.createElement("div");
		list.className = "bot-list";
		container.appendChild(list);

		try {
			const res = await fetch("/api/get_bot_list");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const bots = Array.isArray(data.bots) ? data.bots : [];

			if (bots.length === 0) {
				const empty = document.createElement("p");
				empty.className = "muted";
				empty.textContent = "暂无机器人, 在 bots/ 目录下创建";
				list.replaceChildren(empty);
				return;
			}

			for (const bot of bots) {
				list.appendChild(createBotCard(bot));
			}
		} catch (err) {
			const box = document.createElement("div");
			box.className = "page-error";
			box.textContent = `获取机器人列表失败: ${err.message}`;
			list.replaceChildren(box);
		}
	},
};

/**
 * 创建单个机器人卡片
 *
 * @param {{ id: string, name?: string|null, state?: { enable?: boolean, plugins?: Record<string, boolean> } }} bot
 */
function createBotCard(bot) {
	const card = document.createElement("div");
	card.className = "card bot-card";

	// 标题行: 名字 + 状态徽章
	const head = document.createElement("div");
	head.className = "bot-card-head";

	const name = document.createElement("span");
	name.className = "bot-card-name";
	name.textContent = bot.name || bot.id;
	head.appendChild(name);

	const enabled = Boolean(bot.state?.enable);
	const badge = document.createElement("span");
	badge.className = enabled ? "badge badge-on" : "badge badge-off";
	badge.textContent = enabled ? "已启用" : "已停用";
	head.appendChild(badge);

	// id 标识
	const id = document.createElement("code");
	id.className = "bot-card-id";
	id.textContent = bot.id;

	// 启用的插件列表
	const plugins = Object.entries(bot.state?.plugins ?? {})
		.filter(([, on]) => on)
		.map(([name]) => name);
	const pluginsEl = document.createElement("p");
	pluginsEl.className = "muted bot-card-plugins";
	pluginsEl.textContent = plugins.length > 0 ? `启用插件: ${plugins.join("、")}` : "未启用插件";

	card.append(head, id, pluginsEl);
	return card;
}
