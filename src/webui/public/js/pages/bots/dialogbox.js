/**
 * 机器人页面: "创建机器人" 对话框
 *
 * 由 bots.js 页头 "+" 按钮触发, 提供 id(必填)/name(可选) 表单。
 * 提交后调用后端 POST /api/create_bot:
 * - 成功: 关闭对话框, toast 提示, 回调 onDone (页面据此刷新列表)
 * - 失败: 把后端返回的 err 展示在对话框内, 不关闭
 *
 * 对话框挂载到 document.body (fixed 定位覆盖全屏), 样式见 bots.css 的 .dialog-*。
 * 页面被切换走时由 bots.js 的 destroy() 调用 closeCreateBotDialog() 关闭, 避免残留。
 */
import toast from "../../spa/toast.js";
import { apiFetch } from "../../spa/auth.js";

/** 当前打开的对话框根元素; 非空表示已有对话框打开 (防止重复叠加) */
let root = null;

/**
 * 打开 "创建机器人" 对话框
 * @param {{ onDone?: () => void }} [options] onDone 创建成功后的回调
 */
export function openCreateBotDialog({ onDone } = {}) {
	if (root) return; // 已打开则忽略
	root = build(onDone);
	document.body.appendChild(root);
	// 强制回流后再加 .dialog-open, 让入场 transition 从初始态开始 (淡入 + 上浮)
	void root.offsetWidth;
	root.classList.add("dialog-open");
	// 打开后聚焦 id 输入框, 便于直接输入
	const idInput = root.querySelector(".dialog-id-input");
	idInput?.focus();
	// Esc 关闭
	document.addEventListener("keydown", onKeydown);
}

/** 退场动画时长(ms), 需与 bots.css 中 .dialog-* 的 transition 时长保持一致 */
const CLOSE_MS = 180;

/** 关闭已打开的对话框; 未打开时无操作 */
export function closeCreateBotDialog() {
	const el = root;
	if (!el) return;
	document.removeEventListener("keydown", onKeydown);
	// 移除 .dialog-open 触发反向 transition, 动画结束后再真正移除节点
	el.classList.remove("dialog-open");
	setTimeout(() => {
		if (root === el) {
			root = null;
			el.remove();
		}
	}, CLOSE_MS);
}

function onKeydown(e) {
	if (e.key === "Escape") closeCreateBotDialog();
}

/** 构建对话框 DOM 并绑定事件; 返回根元素 */
function build(onDone) {
	const backdrop = document.createElement("div");
	backdrop.className = "dialog-backdrop";
	backdrop.setAttribute("role", "presentation");

	const form = document.createElement("form");
	form.className = "dialog-card";
	form.setAttribute("role", "dialog");
	form.setAttribute("aria-modal", "true");
	form.setAttribute("aria-label", "创建机器人");

	// 标题 + 说明
	const title = document.createElement("h2");
	title.className = "dialog-title";
	title.textContent = "创建机器人";

	const desc = document.createElement("p");
	desc.className = "dialog-desc";
	desc.textContent = "在 bots/ 目录下新建一个机器人, 之后可单独安装插件与启停";

	// id 字段: 容器为 div, label 用 for 关联输入框 (语义正确且便于点击聚焦)
	const idField = document.createElement("div");
	idField.className = "dialog-field";

	const idLabel = document.createElement("label");
	idLabel.className = "dialog-label";
	idLabel.htmlFor = "dlg-create-id";
	idLabel.textContent = "ID";
	const idRequired = document.createElement("em");
	idRequired.className = "dialog-required";
	idRequired.textContent = " *";
	idRequired.setAttribute("aria-hidden", "true");
	idLabel.append(idRequired);

	const idInput = document.createElement("input");
	idInput.className = "dialog-input dialog-id-input";
	idInput.id = "dlg-create-id";
	idInput.name = "id";
	idInput.required = true;
	idInput.maxLength = 64;
	idInput.autocomplete = "off";
	idInput.spellcheck = false;
	idInput.placeholder = "唯一标识, 例如 my-bot";
	idField.append(idLabel, idInput);

	const idHint = document.createElement("p");
	idHint.className = "dialog-hint";
	idHint.textContent = "将作为 bots/ 下的目录名, 创建后不可更改";
	idField.append(idHint);

	// name 字段
	const nameField = document.createElement("div");
	nameField.className = "dialog-field";

	const nameLabel = document.createElement("label");
	nameLabel.className = "dialog-label";
	nameLabel.htmlFor = "dlg-create-name";
	nameLabel.textContent = "名称 (可选)";

	const nameInput = document.createElement("input");
	nameInput.className = "dialog-input";
	nameInput.id = "dlg-create-name";
	nameInput.name = "name";
	nameInput.autocomplete = "off";
	nameInput.placeholder = "显示在卡片上的名字, 留空则显示 ID";
	nameField.append(nameLabel, nameInput);

	// 错误提示区: 后端错误信息展示在这里
	const error = document.createElement("p");
	error.className = "dialog-error";
	error.hidden = true;

	// 按钮组
	const actions = document.createElement("div");
	actions.className = "dialog-actions";

	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "dialog-btn dialog-cancel";
	cancel.textContent = "取消";

	const submit = document.createElement("button");
	submit.type = "submit";
	submit.className = "dialog-btn dialog-submit";
	submit.textContent = "创建";

	actions.append(cancel, submit);
	form.append(title, desc, idField, nameField, error, actions);
	backdrop.append(form);

	const showError = (message) => {
		error.textContent = message;
		error.hidden = false;
	};

	// 点遮罩自身关闭 (点卡片内部不关)
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) closeCreateBotDialog();
	});
	cancel.addEventListener("click", () => closeCreateBotDialog());

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (submit.disabled) return; // 防重复提交

		const id = idInput.value.trim();
		if (!id) {
			showError("请输入机器人 ID");
			idInput.focus();
			return;
		}

		submit.disabled = true;
		submit.classList.add("loading");
		error.hidden = true;

		try {
			// name 为空时不发送该字段 (与 config.json 的省略行为一致)
			const name = nameInput.value.trim();
			const body = name ? { id, name } : { id };

			const res = await apiFetch("/api/create_bot", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			let data = {};
			try {
				data = await res.json();
			} catch {
				/* 响应体解析失败时使用兜底文案 */
			}
			if (!res.ok) throw new Error(data.err || `HTTP ${res.status}`);

			closeCreateBotDialog();
			toast(`机器人 "${name || id}" 已创建`);
			onDone?.();
		} catch (err) {
			showError(err.message);
		} finally {
			submit.disabled = false;
			submit.classList.remove("loading");
		}
	});

	return backdrop;
}
