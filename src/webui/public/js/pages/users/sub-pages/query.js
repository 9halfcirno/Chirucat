/**
 * 用户管理 — 查询与绑定
 *
 * 围绕两个标识组织功能: 账号ID(account uuid) 与 跨平台ID(internal uuid)
 *
 * - 查询: 平台 + 平台ID -> 账号ID / 跨平台ID / 组内成员
 * - 指定绑定: 把「并入账号」并入「接收账号」所在的跨平台ID (先 dryRun 预检, 再确认执行)
 * - 解绑 / 恢复: 解绑使账号独立成新组; 恢复把它并回上一个跨平台ID
 *
 * 绑定与解绑不可自动撤销, 但 UserManager 会把变更前的组记入 last_internal_id,
 * 因此「恢复上一个跨平台ID」可回退一次。
 *
 * 注意: 聊天侧的 /bind 令牌不受此处影响 —— 用户手里未消费的令牌仍然有效,
 * 其消费结果会覆盖这里的手动绑定, 所以操作成功后给出提示。
 */
import { createButton } from "../../../spa/components/button.js";
import { createDialogWindow } from "../../../spa/components/dialog-window.js";
import toast from "../../../spa/toast.js";
import { callAPI, shortId } from "../user-api.js";

/** 上一次成功查询的目标, 变更后用于刷新结果 */
let lastQuery = null;

/**
 * @param {HTMLDivElement} div
*/
export function renderQueryPage(div) {
	div.classList.add("users-manage");

	// ---- 查询 ----
	const queryCard = document.createElement("section");
	queryCard.className = "card glass users-card";

	const queryTitle = document.createElement("h3");
	queryTitle.textContent = "查询用户";

	const queryForm = document.createElement("div");
	queryForm.className = "users-form";

	const queryPlatform = createField("平台", "如 qq / onebot11");
	const queryId = createField("平台ID", "平台上的用户ID");

	const queryBtn = createButton("查询", () => doQuery());
	queryBtn.classList.add("primary");
	queryForm.append(queryPlatform.wrap, queryId.wrap, queryBtn);

	const resultBox = document.createElement("div");
	resultBox.className = "users-result";

	queryCard.append(queryTitle, queryForm, resultBox);

	// ---- 指定绑定 ----
	const bindCard = document.createElement("section");
	bindCard.className = "card glass users-card";

	const bindTitle = document.createElement("h3");
	bindTitle.textContent = "指定绑定";

	const bindForm = document.createElement("div");
	bindForm.className = "users-bind";

	const srcPlatform = createField("平台", "如 qq / onebot11");
	const srcId = createField("平台ID", "平台上的用户ID");
	const srcGroup = createBindGroup("并入账号", "要并入对方的一方, 合并后不再使用其原跨平台ID", srcPlatform.wrap, srcId.wrap);

	const arrow = document.createElement("span");
	arrow.className = "users-arrow";
	arrow.textContent = "→";

	const dstPlatform = createField("平台", "如 qq / onebot11");
	const dstId = createField("平台ID", "平台上的用户ID");
	const dstGroup = createBindGroup("接收账号", "跨平台ID保留在这一方", dstPlatform.wrap, dstId.wrap);

	const bindBtn = createButton("绑定", () => doBind());
	bindBtn.classList.add("primary");
	bindForm.append(srcGroup, arrow, dstGroup, bindBtn);

	const bindHint = document.createElement("p");
	bindHint.className = "users-hint muted";
	bindHint.textContent = "把「并入账号」并入「接收账号」所在的跨平台ID；两个账号都必须已出现过。执行前会先预检影响范围。";

	bindCard.append(bindTitle, bindForm, bindHint);

	div.append(queryCard, bindCard);

	/** 把下划线输入框组渲染成一行标签 + 输入框 */
	function createField(label, placeholder) {
		const wrap = document.createElement("label");
		wrap.className = "users-field";

		const name = document.createElement("span");
		name.className = "users-field-label";
		name.textContent = label;

		const input = document.createElement("input");
		input.className = "input";
		input.type = "text";
		input.autocomplete = "off";
		input.spellcheck = false;
		if (placeholder) input.placeholder = placeholder;

		wrap.append(name, input);
		return { wrap, input };
	}

	/** 把若干字段包成一组 (带标题与说明), 用于区分绑定双方 */
	function createBindGroup(title, desc, ...fields) {
		const box = document.createElement("div");
		box.className = "users-bind-group";

		const head = document.createElement("span");
		head.className = "users-bind-title";
		head.textContent = title;
		head.title = desc;

		const row = document.createElement("div");
		row.className = "users-bind-row";
		row.append(...fields);

		box.append(head, row);
		return box;
	}

	/** 查询当前输入的目标 */
	async function doQuery() {
		const platform = queryPlatform.input.value.trim();
		const id = queryId.input.value.trim();

		if (!platform || !id) {
			toast("请填写平台与平台ID", { type: "warn" });
			return;
		}

		resultBox.replaceChildren();
		try {
			const data = await callAPI("query_user", { platform, id });
			lastQuery = { platform, id };
			renderResult(data);
		} catch (e) {
			const err = document.createElement("p");
			err.className = "users-error";
			err.textContent = e.message;
			resultBox.append(err);
		}
	}

	/** 变更成功后按上次查询刷新结果 */
	async function refresh() {
		if (!lastQuery) return;
		await callAPI("query_user", lastQuery)
			.then(renderResult)
			.catch(() => { /* 刷新失败静默: 变更本身已提示过结果 */ });
	}

	/** 渲染查询结果 */
	function renderResult(data) {
		resultBox.replaceChildren();

		const info = document.createElement("div");
		info.className = "users-info";
		info.append(
			infoRow("账号ID", idChip(data.accountId)),
			infoRow("跨平台ID", idChip(data.unionId)),
		);

		if (data.lastUnionId) {
			const restoreBtn = createButton("恢复", () => doRestore(data));
			info.append(infoRow("上一个跨平台ID", idChip(data.lastUnionId), restoreBtn));
		}

		const membersTitle = document.createElement("h4");
		membersTitle.textContent = `组内成员（${data.members.length}）`;

		const list = document.createElement("ul");
		list.className = "users-members";
		for (const member of data.members) {
			const li = document.createElement("li");
			li.className = "users-member";

			const badge = document.createElement("span");
			badge.className = "users-badge";
			badge.textContent = member.platform;

			const pid = document.createElement("span");
			pid.className = "mono";
			pid.textContent = member.id;

			const asSource = createButton("作并入", () => fillBind(true, member));
			const asTarget = createButton("作接收", () => fillBind(false, member));

			li.append(badge, pid, idChip(member.accountId), asSource, asTarget);
			list.append(li);
		}

		const actions = document.createElement("div");
		actions.className = "users-actions";

		// 组内只有一个账号时, 解绑只是换一个跨平台ID, 没有意义
		if (data.members.length > 1) {
			const unbindBtn = createButton("解绑该账号", () => doUnbind(data));
			unbindBtn.classList.add("danger");
			actions.append(unbindBtn);
		}

		resultBox.append(info, membersTitle, list, actions);
	}

	/** 一行「标签: 值」 */
	function infoRow(label, ...nodes) {
		const row = document.createElement("div");
		row.className = "users-info-row";

		const name = document.createElement("span");
		name.className = "users-info-label";
		name.textContent = label;

		const value = document.createElement("span");
		value.className = "users-info-value";
		value.append(...nodes);

		row.append(name, value);
		return row;
	}

	/** 把成员填进绑定表单 */
	function fillBind(asSource, member) {
		const platform = asSource ? srcPlatform : dstPlatform;
		const id = asSource ? srcId : dstId;
		platform.input.value = member.platform;
		id.input.value = member.id;
		toast(`已填入${asSource ? "并入" : "接收"}账号`, { type: "info", duration: 1500 });
	}

	/** 预检 -> 确认 -> 执行绑定 */
	async function doBind() {
		const source = { platform: srcPlatform.input.value.trim(), id: srcId.input.value.trim() };
		const target = { platform: dstPlatform.input.value.trim(), id: dstId.input.value.trim() };

		if (!source.platform || !source.id || !target.platform || !target.id) {
			toast("请填写并入与接收双方的平台、平台ID", { type: "warn" });
			return;
		}

		let preview;
		try {
			preview = await callAPI("bind_account", { source, target, dryRun: true });
		} catch (e) {
			toast(`预检失败: ${e.message}`, { type: "error" });
			return;
		}

		if (preview.alreadyBound) {
			toast("两个账号已在同一个跨平台ID下", { type: "warn" });
			return;
		}

		confirmBind(source, target, preview);
	}

	/** 绑定确认对话框: 展示预检到的影响范围 */
	function confirmBind(source, target, preview) {
		const content = document.createElement("div");

		const head = document.createElement("p");
		const s = document.createElement("strong");
		s.textContent = `${source.platform} ${source.id}`;
		const t = document.createElement("strong");
		t.textContent = `${target.platform} ${target.id}`;
		head.append("将 ", s, " 并入 ", t, " 所在的跨平台ID。");

		const list = document.createElement("ul");
		list.className = "users-confirm-list";
		for (const text of [
			`并入账号当前所在组: ${preview.sourceGroupSize} 个账号`,
			`接收账号当前所在组: ${preview.targetGroupSize} 个账号`,
			`合并后接收方所在组: ${preview.afterSize} 个账号`,
			`接收方的跨平台ID: ${shortId(preview.targetUnionId)}`,
		]) {
			const li = document.createElement("li");
			li.textContent = text;
			list.append(li);
		}

		const tip = document.createElement("p");
		tip.className = "users-hint muted";
		tip.textContent = "并入账号原来的组会记入历史, 可用「恢复上一个跨平台ID」回退一次。";

		const tokenTip = document.createElement("p");
		tokenTip.className = "users-hint muted";
		tokenTip.textContent = "注意: 聊天侧 /bind 生成的未消费令牌仍然有效, 其消费结果会覆盖本次绑定。";

		content.append(head, list, tip, tokenTip);

		const dlg = createDialogWindow("确认绑定", content, [
			{ name: "确认绑定", onclick: apply },
			{ name: "取消", onclick: () => dlg.closeDialog() },
		], { cancelable: true });

		async function apply() {
			try {
				const res = await callAPI("bind_account", { source, target, dryRun: false });
				dlg.closeDialog();
				toast(`绑定成功, 目标跨平台ID ${shortId(res.targetUnionId)}`, { type: "info" });
				await refresh();
			} catch (e) {
				toast(`绑定失败: ${e.message}`, { type: "error" });
			}
		}

		document.body.append(dlg);
	}

	/** 解绑确认 -> 执行 */
	function doUnbind(data) {
		const content = document.createElement("div");

		const head = document.createElement("p");
		const s = document.createElement("strong");
		s.textContent = `${data.platform} ${data.id}`;
		head.append("将 ", s, " 从当前跨平台ID中移出, 独立成新的跨平台ID。");

		const tip = document.createElement("p");
		tip.className = "users-hint muted";
		tip.textContent = `原跨平台ID ${shortId(data.unionId)} 会记入历史, 可用「恢复上一个跨平台ID」并回。`;

		content.append(head, tip);

		const dlg = createDialogWindow("确认解绑", content, [
			{ name: "确认解绑", onclick: apply, danger: true },
			{ name: "取消", onclick: () => dlg.closeDialog() },
		], { cancelable: true });

		async function apply() {
			try {
				const res = await callAPI("unbind_account", { platform: data.platform, id: data.id });
				dlg.closeDialog();
				toast(`已解绑, 新跨平台ID ${shortId(res.unionId)}`, { type: "info" });
				await refresh();
			} catch (e) {
				toast(`解绑失败: ${e.message}`, { type: "error" });
			}
		}

		document.body.append(dlg);
	}

	/** 恢复到上一个跨平台ID */
	async function doRestore(data) {
		try {
			const res = await callAPI("restore_internal", { platform: data.platform, id: data.id });
			toast(`已恢复到跨平台ID ${shortId(res.unionId)}`, { type: "info" });
			await refresh();
		} catch (e) {
			toast(`恢复失败: ${e.message}`, { type: "error" });
		}
	}
}

/** 可点击复制的 id 块 */
function idChip(id) {
	const code = document.createElement("code");
	code.className = "mono users-id";
	code.textContent = shortId(id);
	code.title = `${id}（点击复制）`;
	code.addEventListener("click", () => copyText(String(id ?? "")));
	return code;
}

/** 复制到剪贴板 (localhost 属于安全上下文, 剪贴板可用) */
async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		toast("已复制", { type: "info", duration: 1500 });
	} catch {
		toast("复制失败, 请手动选择文本", { type: "warn" });
	}
}
