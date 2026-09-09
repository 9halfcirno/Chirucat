/**
 * 机器人管理页面
 *
 * 调用后端 GET /api/get_bot_list 获取机器人列表, 以卡片形式展示。
 * 卡片容器使用 flex 布局 (见 layout.css 的 .bot-list)。
 * 页面头部右侧提供圆形刷新按钮, 点击后重新拉取列表, 并通过 Toast 提示结果。
 */
import toast from "../../spa/toast.js";
import { apiFetch } from "../../spa/auth.js";
import { createDialogWindow } from "../../spa/components/dialog-window.js";
import { createIconButton } from "../../spa/components/icon-button.js";
import { createDotSwitch } from "../../spa/components/dot-switch.js";
import { createAddForm, submitAddForm } from "./add-bot-form.js";
import { createBotContent } from "./bot-content.js";
export default {
	id: "bots",
	title: "机器人",
	styles: ["/js/pages/bots/bots.css", "/js/pages/bots/bot-div.css"],

	async render(container) {

		// 页面头部: 左侧说明文字, 右侧圆形刷新按钮
		const head = document.createElement("div");
		head.className = "bots-head";

		const tip = document.createElement("p");
		tip.className = "muted";
		tip.textContent = "管理机器人实例";
		head.append(tip);
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

				if (fromRefresh) toast(`刷新失败: ${err.message}`, { type: "error", duration: 5000 });
			} finally {
				refresh.classList.remove("loading");
			}
		};

		/**
		 * 打开"创建机器人"对话框。
		 * "确定"按钮与表单内 Enter 共用 onCreate: 提交成功后关闭对话框、toast
		 * 提示并刷新列表; 失败时错误已展示在表单内, 对话框保持打开供修改重试。
		 */
		const openCreateBotDialog = () => {
			const form = createAddForm();

			let dialog = null;
			let submitting = false; // Enter 与按钮双入口共用, 防止重复提交

			const onCreate = async () => {
				if (submitting) return;
				submitting = true;
				try {
					const result = await submitAddForm(form);
					if (!result.ok) return; // 错误已展示在表单错误区
					dialog.closeDialog();
					toast(`机器人 "${result.name || result.id}" 已创建`);
					await load(); // 刷新列表, 让新卡片立即出现
				} finally {
					submitting = false;
				}
			};

			dialog = createDialogWindow("创建机器人", form, [{
				name: "确定",
				onclick: onCreate,
			}, {
				name: "取消",
				onclick: () => dialog.closeDialog(),
			}], true);
			document.body.append(dialog);

			// Enter 快捷提交 (与点"确定"等价)
			form.addEventListener("keydown", (e) => {
				if (e.key !== "Enter") return;
				e.preventDefault();
				void onCreate();
			});

			// 打开后聚焦 id 输入框, 便于直接输入
			form.querySelector('[name="id"]')?.focus();
		};

		// 页面右上角: "+" 创建按钮 + 刷新按钮
		const add = createIconButton("/img/icons/add.svg", openCreateBotDialog);
		add.title = "添加机器人";
		add.setAttribute("aria-label", "添加机器人");
		head.append(add);

		const refresh = createIconButton("/img/icons/refresh.svg", () => load(true))
		refresh.classList.add("bot-refresh-btn");
		refresh.title = "刷新机器人列表";
		refresh.setAttribute("aria-label", "刷新机器人列表");
		head.append(refresh);

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


	let enabled = Boolean(bot.state?.enable);
	const dotSwh = createDotSwitch(async (_, state) => {
		try {
			const res = await apiFetch("/api/set_bot_state", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ id: bot.id, state }),
			}).then((r) => r.json());

			if (res.success) {
				const label = res.state ? "点击停用" : "点击启用";
				dotSwh.title = label;
				dotSwh.setAttribute("aria-label", label);
				dotSwh.setAttribute("aria-pressed", String(res.state));
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

	card.onclick = (e) => {
		if (e.target === dotSwh) return;
		let dialog = createDialogWindow(
			"Bot信息", 
			createBotContent(bot),
			[],
			true);
		document.body.append(dialog);
	}

	card.append(head, id);
	return card;
}
