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
import { createDialogWindow } from "../../spa/components/dialog-window.js";
import { createIconButton } from "../../spa/components/icon-button.js";
import { createDotSwitch } from "../../spa/components/dot-switch.js";
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

		const add = createIconButton("/img/icons/add.svg", () => {
			let dialog = createDialogWindow("创建机器人", "", [], true);
			document.body.append(dialog);
		})
		add.title = "添加机器人";
		add.setAttribute("aria-label", "添加机器人")
		head.append(add);

		// add.addEventListener("click", () => openCreateBotDialog({ onDone: () => load(true) }));

		const refresh = createIconButton("/img/icons/refresh.svg", () => load(true))
		refresh.classList.add("bot-refresh-btn");
		refresh.title = "刷新机器人列表";
		refresh.setAttribute("aria-label", "刷新机器人列表");
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

		await load();
	},

	destroy() {
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


	// !!!屎山警告!!!
	// 	我也不知道这块状态是怎么变的, 单纯一次就好了

	let enabled = Boolean(bot.state?.enable);
	const dotSwh = createDotSwitch(async () => {
		try {
			const res = await apiFetch("/api/set_bot_state", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ id: bot.id, state: !enabled }),
			}).then((r) => r.json());

			if (res.success) {
				const label = res.state ? "点击停用" : "点击启用";
				dotSwh.title = label;
				dotSwh.setAttribute("aria-label", label);
				dotSwh.setAttribute("aria-pressed", String(res.state));
				enabled = res.state;
				toast((bot.name ?? bot.id) + (res.state ? "已启用" : "已停用"));
			} else {
				toast(`设置状态失败: ${res.err || "未知错误"}`, { type: "error", duration: 5000 });
			}
			return res.state;
		} catch (err) {
			toast(`设置Bot状态失败: ${err.message}`, { type: "error", duration: 5000 });
		}
	}, enabled);
	dotSwh.title = enabled ? "点击停用" : "点击启用";
	dotSwh.setAttribute("aria-label", dotSwh.title);
	dotSwh.setAttribute("aria-pressed", String(enabled));
	head.appendChild(dotSwh);


	// id 标识
	const id = document.createElement("code");
	id.className = "bot-card-id";
	id.textContent = bot.id;


	card.append(head, id);
	return card;
}
