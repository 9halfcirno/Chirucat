/**
 * 机器人管理页面
 *
 * 调用后端 GET /api/get_bot_list 获取机器人列表, 以卡片形式展示。
 * 卡片容器使用 flex 布局 (见 layout.css 的 .bot-list)。
 * 页面头部右侧提供圆形刷新按钮, 点击后重新拉取列表, 并通过 Toast 提示结果。
 */
import toast from "../../spa/toast.js";
import { apiFetch } from "../../spa/auth.js";
import { openCreateBotDialog, closeCreateBotDialog } from "./dialogbox.js";
export default {
	id: "bots",
	title: "机器人",
	styles: ["/js/pages/bots/bots.css"],

	async render(container) {

		// 页面头部: 左侧说明文字, 右侧圆形刷新按钮
		const head = document.createElement("div");
		head.className = "bots-head";

		const tip = document.createElement("p");
		tip.className = "muted";
		tip.textContent = "管理机器人实例";
		head.append(tip);

		const add = document.createElement("button");
		add.type = "button";
		add.classList.add("bot-btn");
		add.title = "创建机器人";
		add.setAttribute("aria-label", "创建机器人");
		const addIcon = document.createElement("img");
		addIcon.src = "/img/icons/add.svg";
		addIcon.alt = "";
		add.append(addIcon);
		head.append(add);

		// 点击 + 打开创建对话框; 创建成功后由回调触发重拉列表
		add.addEventListener("click", () => openCreateBotDialog({ onDone: () => load(true) }));

		const refresh = document.createElement("button");
		refresh.type = "button";
		refresh.classList.add("bot-btn");
		refresh.classList.add("bot-refresh-btn");
		refresh.title = "刷新机器人列表";
		refresh.setAttribute("aria-label", "刷新机器人列表");
		const refreshIcon = document.createElement("img");
		refreshIcon.src = "/img/icons/refresh.svg";
		refreshIcon.alt = "";
		refresh.append(refreshIcon);
		head.append(refresh);

		container.append(head);

		// bot 卡片容器
		const list = document.createElement("div");
		list.className = "bot-list";
		container.appendChild(list);

		// 拉取并渲染机器人列表; 刷新按钮点击时重复调用
		const load = async (fromRefresh = false) => {
			refresh.classList.add("loading");
			try {
				const res = await apiFetch("/api/scan_bots");
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				const bots = Array.isArray(data.bots) ? data.bots : [];

				if (bots.length === 0) {
					const empty = document.createElement("p");
					empty.className = "muted";
					empty.textContent = "暂无机器人, 点击右上角 + 创建";
					list.replaceChildren(empty);
					if (fromRefresh) toast("机器人列表已刷新");
					return;
				}

				list.replaceChildren(...bots.map(createBotCard));
				if (fromRefresh) toast("机器人列表已刷新");
			} catch (err) {
				// const box = document.createElement("div");
				// box.className = "page-error";
				// box.textContent = `获取机器人列表失败: ${err.message}`;
				// list.replaceChildren(box);
				if (fromRefresh) toast(`刷新失败: ${err.message}`, { type: "error", duration: 5000 });
			} finally {
				refresh.classList.remove("loading");
			}
		};

		refresh.addEventListener("click", () => load(true));

		await load();
	},

	destroy() {
		// 页面切换走时关闭可能还开着的创建对话框, 避免残留
		closeCreateBotDialog();
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

	const name = document.createElement("div");
	name.className = "bot-card-name";
	name.textContent = bot.name || bot.id;
	head.appendChild(name);

	const enabled = Boolean(bot.state?.enable);
	const badge = document.createElement("button");
	badge.type = "button";
	badge.className = enabled ? "badge badge-on" : "badge badge-off";
	badge.title = enabled ? "点击停用" : "点击启用";
	badge.setAttribute("aria-label", badge.title);
	badge.setAttribute("aria-pressed", String(enabled));
	head.appendChild(badge);

	let handling = false;
	badge.onclick = async () => {
		if (handling || badge.disabled) return;
		handling = true;
		badge.classList.add("loading");
		badge.disabled = true;

		const next = !badge.classList.contains("badge-on");
		try {
			const res = await apiFetch("/api/set_bot_state", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ id: bot.id, state: next }),
			}).then((r) => r.json());

			if (res.success) {
				badge.classList.toggle("badge-on", next);
				badge.classList.toggle("badge-off", !next);
				const label = next ? "点击停用" : "点击启用";
				badge.title = label;
				badge.setAttribute("aria-label", label);
				badge.setAttribute("aria-pressed", String(next));
				toast((bot.name ?? bot.id) + (next ? "已启用" : "已停用"));
			} else {
				toast(`设置状态失败: ${res.err || "未知错误"}`, { type: "error", duration: 5000 });
			}
		} catch (err) {
			toast(`设置Bot状态失败: ${err.message}`, { type: "error", duration: 5000 });
		} finally {
			handling = false;
			badge.classList.remove("loading");
			badge.disabled = false;
		}
	};

	// id 标识
	const id = document.createElement("code");
	id.className = "bot-card-id";
	id.textContent = bot.id;


	card.append(head, id);
	return card;
}
