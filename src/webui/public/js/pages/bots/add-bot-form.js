/**
 * 机器人页面: "创建机器人" 对话框表单
 *
 * 由 bots.js 页头 "+" 按钮打开, 表单内容塞进 createDialogWindow 的 inner,
 * 提交由对话框按钮栏的"确定"触发。职责分两层:
 * - createAddForm(): 构建表单 DOM (id 必填 + 名称可选)。返回普通 div 而非
 *   <form>: 按钮在对话框 footer 里, 因此"提交"只是一个动作, 由调用方绑定
 *   到"确定"按钮与表单内 Enter (见 bots.js 的 openCreateBotDialog)。
 * - submitAddForm(formEl): 读取输入并 POST /api/create_bot。错误 (前端必填
 *   校验或服务端 { err, code }) 直接展示在表单错误区, 对话框保持打开;
 *   成功返回 { ok: true, id, name }, 由调用方决定关闭对话框、toast、刷新列表。
 *
 * id 完整规则以服务端为准 (helpers/bot-helper.ts 的 isValidBotId), 前端只拦
 * 截必填与长度上限, 减少无效请求; 其余交给服务端 400 提示。
 */
import { apiFetch } from "../../spa/auth.js";

/** 自增序号: 保证多次打开的输入框 id 全局唯一 (label for 不会串到旧输入框) */
let formSeq = 0;

/**
 * 构建"创建机器人"表单 DOM
 * @returns {HTMLDivElement} 表单根元素, 内部含 id / name 输入框与错误提示区
 */
export function createAddForm() {
	const form = document.createElement("div");
	form.className = "add-bot-form";

	const seq = ++formSeq;

	// id 字段 (必填): label for 关联输入框, 点击 label 即可聚焦
	const idField = document.createElement("div");
	idField.className = "dialog-field";

	const idLabel = document.createElement("label");
	idLabel.className = "dialog-label";
	idLabel.htmlFor = `add-bot-id-${seq}`;
	idLabel.textContent = "ID";
	const required = document.createElement("em");
	required.className = "dialog-required";
	required.textContent = " *";
	required.setAttribute("aria-hidden", "true");
	idLabel.append(required);

	const idInput = document.createElement("input");
	idInput.className = "dialog-input";
	idInput.id = `add-bot-id-${seq}`;
	idInput.name = "id";
	idInput.type = "text";
	idInput.required = true;
	idInput.maxLength = 64;
	idInput.autocomplete = "off";
	idInput.spellcheck = false;
	idInput.placeholder = "唯一标识, 例如 my-bot";

	const idHint = document.createElement("p");
	idHint.className = "dialog-hint";
	idHint.textContent = "将作为 bots/ 下的目录名, 创建后不可更改";

	idField.append(idLabel, idInput, idHint);

	// name 字段 (可选): 留空则卡片只显示 id
	const nameField = document.createElement("div");
	nameField.className = "dialog-field";

	const nameLabel = document.createElement("label");
	nameLabel.className = "dialog-label";
	nameLabel.htmlFor = `add-bot-name-${seq}`;
	nameLabel.textContent = "名称 (可选)";

	const nameInput = document.createElement("input");
	nameInput.className = "dialog-input";
	nameInput.id = `add-bot-name-${seq}`;
	nameInput.name = "name";
	nameInput.type = "text";
	nameInput.autocomplete = "off";
	nameInput.spellcheck = false;
	nameInput.placeholder = "显示在卡片上的名字, 留空则显示 ID";

	nameField.append(nameLabel, nameInput);

	// 错误提示区: 前端校验与服务端错误都展示在这里, 默认隐藏
	const error = document.createElement("p");
	error.className = "dialog-error";
	error.hidden = true;

	form.append(idField, nameField, error);

	return form;
}

/**
 * 读取表单并提交创建请求。永不抛出异常:
 * - 输入不完整或服务端拒绝: 错误展示在表单错误区, 返回 { ok: false }
 * - 创建成功: 返回 { ok: true, id, name } (均已 trim)
 *
 * @param {HTMLElement} formEl createAddForm() 返回的表单根元素
 * @returns {Promise<{ ok: true, id: string, name: string } | { ok: false }>}
 */
export async function submitAddForm(formEl) {
	const idInput = formEl.querySelector('[name="id"]');
	const nameInput = formEl.querySelector('[name="name"]');
	const errorEl = formEl.querySelector(".dialog-error");

	const showError = (message) => {
		errorEl.textContent = message;
		errorEl.hidden = false;
	};

	const id = idInput.value.trim();
	const name = nameInput.value.trim();

	// 前端只拦必填; id 的合法字符规则由服务端校验并回传提示
	if (!id) {
		showError("请输入机器人 ID");
		idInput.focus();
		return { ok: false };
	}

	// 提交前清掉上一次的错误
	errorEl.textContent = "";
	errorEl.hidden = true;

	try {
		const res = await apiFetch("/api/create_bot", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// name 为空时不发送该字段 (与后端省略 config.json 中 name 的行为一致)
			body: JSON.stringify(name ? { id, name } : { id }),
		});

		let data = {};
		try {
			data = await res.json();
		} catch {
			/* 响应体解析失败时使用兜底文案 */
		}

		if (!res.ok) {
			// 后端错误形如 { err, code }, err 可直接展示给用户
			showError(data.err || `HTTP ${res.status}`);
			return { ok: false };
		}

		return { ok: true, id, name };
	} catch (err) {
		// 网络错误等: 展示在错误区, 对话框保持打开供重试
		showError(err.message);
		return { ok: false };
	}
}
