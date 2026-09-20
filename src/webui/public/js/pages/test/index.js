/**
 * 测试页面: 插件配置链路的手动测试面板
 *
 * 把整条链路摊开给手动验:
 *   get_bot_list → get_plugin_list → get_plugin_config → (表单编辑) → update_plugin_config
 *
 * 每个请求与响应都会按时间倒序打到下方的输出区, 错误响应里的 details
 * (字段级校验错误) 也会单独列出来, 方便和后端对账。
 *
 * 建议试的用例:
 * - 展开分组填点东西 → 关掉分组(隐藏) → 保存 → 重新读取: 值应该还在
 *   (前端不提交隐藏项, 后端保留旧值)
 * - 清空必填项 → 保存: 后端返回 400, details 里点名出错字段
 * - 保存后用 [查看 getValues()] 对比表单值与后端回传的规范化值
 */
import { apiFetch } from "../../spa/auth.js";
import { createButton } from "../../spa/components/button.js";
import { createConfigList } from "../../spa/components/config-editor.js";
import toast from "../../spa/toast.js";

export default {
	id: "test",
	title: "测试页面",

	/**
	 * @param {HTMLDivElement} container
	 */
	render(container) {
		container.append(createPluginConfigTester());
	},
};

function createPluginConfigTester() {
	const root = document.createElement("div");
	root.style.display = "flex";
	root.style.flexDirection = "column";
	root.style.gap = "0.9em";

	/** 当前目标与表单实例 */
	const current = { bot: "", plugin: "", config: null };

	/* ---------- ① 目标选择 ---------- */

	const botField = createSelectField("Bot");
	const pluginField = createSelectField("插件");

	const loadBtn = createButton("加载配置", () => loadConfig());
	const reloadBtn = createButton("重新读取", () => loadConfig());
	const saveBtn = createButton("保存", () => saveConfig());
	const resetBtn = createButton("重置为默认", () => {
		if (!current.config) return toast("尚未加载配置", { type: "warn" });
		current.config.reset();
		log("本地", "已重置为定义里的 default (尚未提交)");
	});
	const validateBtn = createButton("本地校验", () => {
		if (!current.config) return toast("尚未加载配置", { type: "warn" });
		const errors = current.config.validate();
		log("本地 validate()", errors.length ? errors : "通过 (无错误)");
	});
	const valuesBtn = createButton("查看 getValues()", () => {
		if (!current.config) return toast("尚未加载配置", { type: "warn" });
		log("本地 getValues()", current.config.getValues());
	});

	const toolbar = document.createElement("div");
	toolbar.style.display = "flex";
	toolbar.style.flexWrap = "wrap";
	toolbar.style.gap = "0.5em";
	toolbar.style.alignItems = "center";
	toolbar.append(
		botField.el, pluginField.el,
		loadBtn, reloadBtn, saveBtn,
		resetBtn, validateBtn, valuesBtn,
	);

	/* ---------- ② 表单区 ---------- */

	const formBox = document.createElement("div");
	formBox.style.padding = "0.6em";
	formBox.style.border = "1px dashed rgba(128, 128, 128, 0.45)";
	formBox.style.borderRadius = "0.5em";
	formBox.append("先选 Bot 与插件, 再点 [加载配置]");

	const hint = document.createElement("p");
	hint.style.margin = "0";
	hint.style.opacity = "0.75";
	hint.textContent =
		"试这个: 展开分组填点东西 → 关掉分组(隐藏) → 保存 → 重新读取, 值应该还在" +
		"(前端不提交隐藏项, 后端保留旧值)。";

	/* ---------- ③ 输出区 ---------- */

	const output = document.createElement("div");
	output.style.maxHeight = "24em";
	output.style.overflow = "auto";
	output.style.padding = "0.5em";
	output.style.border = "1px solid rgba(128, 128, 128, 0.35)";
	output.style.borderRadius = "0.5em";
	output.style.fontSize = "0.9em";

	const clearBtn = createButton("清空输出", () => { output.textContent = ""; });

	root.append(
		section("① 目标", toolbar),
		section("② 配置表单", formBox, hint),
		section("③ 输出", clearBtn, output),
	);

	/* ---------- 行为 ---------- */

	botField.select.addEventListener("change", () => { void onBotChange(); });

	async function loadBots() {
		const { ok, data } = await call("get_bot_list", "get_bot_list", null, "GET");
		if (!ok) return;

		const bots = data?.bots ?? [];
		if (bots.length === 0) {
			formBox.textContent = "没有可用的 Bot";
			return;
		}

		fillSelect(botField.select, bots.map((bot) => ({
			value: bot.id,
			label: `${bot.name || bot.id} (${bot.id})`,
		})));
		await onBotChange();
	}

	async function onBotChange() {
		current.bot = botField.select.value;
		current.plugin = "";
		resetForm("Bot 已切换, 选择插件后点 [加载配置]");

		if (!current.bot) return;

		const { ok, data } = await call("get_plugin_list", "get_plugin_list", { bot: current.bot });
		if (!ok) return;

		const plugins = [...(data?.plugins?.global ?? []), ...(data?.plugins?.bot ?? [])];
		if (plugins.length === 0) {
			formBox.textContent = "该 Bot 下没有插件 (需要先启动一次 Bot 才会扫描插件)";
			return;
		}

		fillSelect(pluginField.select, plugins.map((plugin) => ({
			value: plugin.id,
			label: `${plugin.name || plugin.id}${plugin.config ? "" : " — 未声明配置"}`,
		})));
	}

	async function loadConfig() {
		if (!current.bot) return toast("请先选择 Bot", { type: "warn" });

		const id = pluginField.select.value;
		if (!id) return toast("请先选择插件", { type: "warn" });

		current.plugin = id;
		const { ok, data } = await call("get_plugin_config", "get_plugin_config", {
			bot: current.bot,
			id,
		});

		if (!ok) {
			resetForm(`读取失败: ${data?.err ?? "未知错误"}`);
			return;
		}

		current.config = createConfigList(data.define);
		current.config.setValues(data.config ?? {});

		formBox.textContent = "";
		formBox.append(current.config.el);

		// 定义与当前值一并打出来, 方便和后端对账
		log("返回的 define", data.define);
		log("返回的 config", data.config);
		toast(`已加载插件 ${id} 的配置`);
	}

	async function saveConfig() {
		if (!current.config) return toast("尚未加载配置", { type: "warn" });

		const values = current.config.getValues();
		log("提交的 getValues()", values);

		const { ok, data } = await call("update_plugin_config", "update_plugin_config", {
			bot: current.bot,
			id: current.plugin,
			config: values,
		});

		if (!ok) {
			if (Array.isArray(data?.details)) log("字段级错误 details", data.details);
			toast(data?.err ?? "保存失败", { type: "error" });
			return;
		}

		toast("保存成功");
		// 用后端回传的规范化值对齐表单: 能直接看到隐藏项/缺失键被补齐的结果
		current.config.setValues(data.config ?? {});
		log("已用后端返回值对齐表单", data.config);
	}

	/* ---------- 工具 ---------- */

	function resetForm(message) {
		current.config = null;
		formBox.textContent = "";
		if (message) formBox.append(message);
	}

	/**
	 * 发一个 API 请求并把请求/响应打到输出区
	 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
	 */
	async function call(label, path, body, method = "POST") {
		log(`→ ${method} /api/${path}`, method === "GET" ? "(无请求体)" : body ?? {});

		let res;
		try {
			res = await apiFetch(`/api/${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
			});
		} catch (e) {
			log(`✗ ${path}`, `请求失败: ${e.message}`);
			toast(`请求失败: ${e.message}`, { type: "error" });
			return { ok: false, status: 0, data: null };
		}

		const data = await res.json().catch(() => null);
		log(`${res.ok ? "✓" : "✗"} ${path} (HTTP ${res.status})`, data ?? "(空响应)");
		return { ok: res.ok, status: res.status, data };
	}

	/** 把一条记录插到输出区顶部 (最新的在最上面) */
	function log(label, value) {
		const line = document.createElement("div");
		line.style.borderTop = "1px solid rgba(128, 128, 128, 0.3)";
		line.style.padding = "0.35em 0";

		const head = document.createElement("div");
		head.style.fontWeight = "bold";
		head.textContent = `${new Date().toLocaleTimeString()}  ${label}`;
		line.append(head);

		if (value !== undefined) {
			const pre = document.createElement("pre");
			pre.style.margin = "0.25em 0 0";
			pre.style.whiteSpace = "pre-wrap";
			pre.style.wordBreak = "break-all";
			pre.textContent = typeof value === "string" ? value : stringify(value);
			line.append(pre);
		}

		output.prepend(line);
	}

	void loadBots();
	return root;
}

/* ---------- 纯 DOM 工具 ---------- */

/** 生成一个带标题的区块 */
function section(title, ...children) {
	const box = document.createElement("section");
	const head = document.createElement("h3");
	head.textContent = title;
	head.style.margin = "0 0 0.4em";
	box.append(head, ...children);
	return box;
}

/** label + select */
function createSelectField(label) {
	const el = document.createElement("label");
	el.style.display = "inline-flex";
	el.style.alignItems = "center";
	el.style.gap = "0.35em";
	el.append(label);

	const select = document.createElement("select");
	select.style.minWidth = "12em";
	el.append(select);

	return { el, select };
}

/** 填充下拉项 */
function fillSelect(select, items) {
	select.textContent = "";
	for (const item of items) {
		const option = document.createElement("option");
		option.value = item.value;
		option.textContent = item.label;
		select.append(option);
	}
}

/** JSON 序列化, 出错时退回 String */
function stringify(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
