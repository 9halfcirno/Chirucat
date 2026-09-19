/**
 * Chirucat WebUI 配置列表组件
 *
 * 把 src/config/schema.json 描述的控件定义 (define) 渲染成可交互的配置表单。
 *
 * 结构与取值约定:
 *
 * - 按 `define.controls` 声明顺序递归渲染。`group` 对应值里的一层嵌套对象,
 *   `table` 对应一个行对象数组, 其余类型都是叶子节点。
 * - `getValues()` 返回 `{ id: 值, groupId: { ... }, tableId: [{ 子id: 值 }] }`。
 * - `visible` 判定为假的控件用 display: none 隐藏, 且**不出现在 getValues()
 *   结果里** (内部仍保留其值, 重新显示时用户填过的内容还在)。
 * - `table` 内的控件忽略 `visible`, 其 id 只在行内作用域可见, 不可被外部 ref。
 * - `table` 的行数据来自 `default: [{ 子id: 值 }]`; 未提供 default 时只有表头。
 * - `text` 只渲染说明文字, 不产生值。
 */

import { createIconButton } from "./icon-button.js";

/** 顶层/分组内控件: 参与 visible 求值 */
const NORMAL_OPTS = { inline: false };
/** table 行内控件: 不渲染 label (表头已给出), 且忽略 visible */
const INLINE_OPTS = { inline: true };

/* ---------- 值工具 ---------- */

/** 深拷贝一个配置值 (配置值只含原始类型 / 数组 / 普通对象) */
function clone(value) {
	if (Array.isArray(value)) return value.map(clone);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value)) out[key] = clone(value[key]);
		return out;
	}
	return value;
}

/** 空值判定: undefined / null / 空串 / 空数组 都视为未填写 */
function isEmpty(value) {
	if (value === undefined || value === null || value === "") return true;
	if (Array.isArray(value) && value.length === 0) return true;
	return false;
}

/** 按控件类型给出默认值 (table 的行由调用方单独展开) */
function defaultValueOf(define) {
	switch (define.type) {
		case "group":
			return {};
		case "table":
			return [];
		case "checkbox":
			return Array.isArray(define.default) ? clone(define.default) : [];
		case "switch":
			return define.default === true;
		case "slider":
			return typeof define.default === "number" ? define.default : (define.min ?? 0);
		case "text":
			return undefined;
		default:
			return define.default === undefined ? "" : clone(define.default);
	}
}

/* ---------- 对外入口 ---------- */

/**
 * 创建配置列表
 *
 * @param {{
 * 	version?: string,
 * 	controls: Array<object>,
 * }} define 配置定义 (schema.json 中 `Form Controls Config` 描述的对象)
 * @returns {{
 * 	el: HTMLElement,
 * 	getValues: () => object,
 * 	setValues: (values: object) => void,
 * 	validate: () => Array<{ id: string, label: string, message: string }>,
 * 	reset: () => void,
 * }} 控制器对象: `el` 是待挂载的根元素
 */
export function createConfigList(define) {
	const root = document.createElement("div");
	root.classList.add("config-list");

	const controls = Array.isArray(define?.controls) ? define.controls : [];
	if (!Array.isArray(define?.controls)) {
		console.warn("[config] 配置定义缺少 controls 数组, 已渲染为空列表");
	}

	/** 根值容器: 每个控件直接读写自己所属层级的对象 */
	const holder = {};
	/** 短 id -> 节点, 供 visible.ref 解析 (不含 table 行内控件) */
	const registry = new Map();
	/** 顶层节点, 按 define.controls 顺序 */
	const nodes = [];

	const ctx = {
		registry,
		/** 任意控件的值发生变化: 重算全部可见性 (配置项数量很少, 不做增量优化) */
		onValueChange() {
			for (const node of nodes) node.refreshVisible();
		},
	};

	for (const control of controls) {
		const node = buildControl(control, holder, ctx, NORMAL_OPTS);
		nodes.push(node);
		root.append(node.el);
	}

	// 全部节点构建完成后再求值: 此时 registry 完整, ref 一定能解析到目标
	ctx.onValueChange();

	return {
		el: root,

		getValues() {
			const values = {};
			for (const node of nodes) node.collect(values);
			return values;
		},

		setValues(values) {
			const source = values && typeof values === "object" ? values : {};
			for (const node of nodes) node.apply(source[node.key]);
			ctx.onValueChange();
		},

		validate() {
			for (const el of root.querySelectorAll(".config-invalid")) {
				el.classList.remove("config-invalid");
			}
			const errors = [];
			for (const node of nodes) node.validate(errors, "");
			return errors;
		},

		reset() {
			for (const node of nodes) node.reset();
			ctx.onValueChange();
		},
	};
}

/* ---------- 节点构建 ---------- */

/**
 * 构建单个控件节点
 *
 * @param {object} define 控件定义
 * @param {object} holder 该控件所属的值容器 (直接读写它的 define.id 属性)
 * @param {object} ctx 上下文 `{ registry, onValueChange }`
 * @param {{ inline: boolean }} opts inline 表示控件位于 table 行内
 * @returns {object} 节点
 */
function buildControl(define, holder, ctx, opts) {
	if (!define || typeof define !== "object") {
		console.warn("[config] 无效的控件定义, 已跳过:", define);
		return buildPlaceholder(null, ctx, opts);
	}

	switch (define.type) {
		case "group":
			return buildGroup(define, holder, ctx, opts);
		case "table":
			return buildTable(define, holder, ctx, opts);
		case "text":
			return buildText(define, ctx, opts);
		case "input":
			return buildInput(define, holder, ctx, opts);
		case "textarea":
			return buildTextarea(define, holder, ctx, opts);
		case "switch":
			return buildSwitch(define, holder, ctx, opts);
		case "select":
			return buildSelect(define, holder, ctx, opts);
		case "checkbox":
			return buildCheckbox(define, holder, ctx, opts);
		case "slider":
			return buildSlider(define, holder, ctx, opts);
		default:
			console.warn(`[config] 未知的控件类型: ${define.type}, 已跳过运行时渲染`);
			return buildPlaceholder(define, ctx, opts);
	}
}

/** 不产生值的节点 (text / 兜底): 只参与显隐, 不参与取值与校验 */
function createInertNode(define, el, ctx, opts) {
	const def = define ?? {};
	const node = {
		define: def,
		key: undefined,
		el,
		get: () => undefined,
		collect() { },
		apply() { },
		validate() { },
		reset() { },
	};
	bindVisible(node, def, el, ctx, opts);
	return node;
}

/** 未知/非法定义的兜底节点: 只展示 label */
function buildPlaceholder(define, ctx, opts) {
	const el = document.createElement("div");
	el.classList.add("config-group", "config-placeholder");
	const label = document.createElement("p");
	label.className = "config-text";
	label.textContent = define?.label ?? "";
	el.append(label);
	return createInertNode(define, el, ctx, opts);
}

/** 建立一个控件外壳: label + 控件槽 + desc */
function createFieldShell(define, opts) {
	const el = document.createElement("div");
	el.classList.add("config-group");
	if (define.id) el.dataset.id = define.id;

	if (!opts.inline && define.label) el.append(createLabel(define));

	const field = document.createElement("div");
	field.className = "config-field";
	el.append(field);

	if (!opts.inline && define.desc) {
		const desc = document.createElement("small");
		desc.className = "config-desc";
		desc.textContent = define.desc;
		el.append(desc);
	}

	return { el, field };
}

/** 控件标签, required 时追加一个红色的星号 */
function createLabel(define) {
	const label = document.createElement("span");
	label.className = "config-label";
	label.textContent = define.label ?? "";
	if (define.required) {
		const star = document.createElement("i");
		star.className = "config-required";
		star.textContent = "*";
		label.append(star);
	}
	return label;
}

/** 把节点登记进短 id 索引, 供 visible.ref 解析 (table 行内控件不登记) */
function registerNode(ctx, opts, key, node) {
	if (opts.inline || !key) return;
	if (ctx.registry.has(key)) {
		console.warn(`[config] 控件 id 重复, 后者覆盖前者: ${key}`);
	}
	ctx.registry.set(key, node);
}

/** 绑定 visible 的求值与显隐 (table 行内控件忽略 visible) */
function bindVisible(node, define, el, ctx, opts) {
	node.visible = true;
	node.refreshVisible = () => {
		if (opts.inline) return;
		const next = evalVisible(define.visible, ctx, 0);
		if (next === node.visible) return;
		node.visible = next;
		el.style.display = next ? "" : "none";
	};
}

/**
 * 叶子控件的公共部分
 *
 * @param {object} define 控件定义
 * @param {object} holder 值容器
 * @param {object} ctx 上下文
 * @param {{ inline: boolean }} opts 渲染选项
 * @param {HTMLElement} el 控件外壳
 * @param {() => void} sync 把 holder 的当前值刷回 DOM
 */
function createLeafNode(define, holder, ctx, opts, el, sync) {
	const key = define.id;

	if (!Object.prototype.hasOwnProperty.call(holder, key)) {
		holder[key] = defaultValueOf(define);
	}

	const node = {
		define,
		key,
		el,

		get: () => holder[key],

		collect(out) {
			if (!node.visible) return; // 隐藏项不出现在取值结果里
			out[key] = holder[key];
		},

		apply(value) {
			holder[key] = value === undefined ? defaultValueOf(define) : clone(value);
			sync();
		},

		validate(errors, path) {
			if (!node.visible) return; // 隐藏项不参与 required 校验
			if (define.required && isEmpty(holder[key])) {
				const label = define.label ?? key;
				errors.push({
					id: path ? `${path}.${key}` : key,
					label,
					message: `${label} 不能为空`,
				});
				el.classList.add("config-invalid");
			}
		},

		reset() {
			holder[key] = defaultValueOf(define);
			sync();
		},
	};

	bindVisible(node, define, el, ctx, opts);
	registerNode(ctx, opts, key, node);
	sync();

	return node;
}

/* ---------- 各类型控件 ---------- */

function buildInput(define, holder, ctx, opts) {
	const { el, field } = createFieldShell(define, opts);

	const input = document.createElement("input");
	input.type = "text";
	input.className = "config-input";
	if (define.placeholder) input.placeholder = define.placeholder;
	for (const [name, value] of Object.entries(define.attr ?? {})) {
		input.setAttribute(name, String(value));
	}
	input.addEventListener("input", () => {
		holder[define.id] = input.value;
		ctx.onValueChange();
	});
	field.append(input);

	return createLeafNode(define, holder, ctx, opts, el, () => {
		const value = holder[define.id];
		input.value = value === undefined || value === null ? "" : String(value);
	});
}

function buildTextarea(define, holder, ctx, opts) {
	const { el, field } = createFieldShell(define, opts);

	const textarea = document.createElement("textarea");
	textarea.className = "config-textarea";
	textarea.rows = typeof define.rows === "number" ? define.rows : 3;
	if (define.placeholder) textarea.placeholder = define.placeholder;
	// attr 在 rows 之后应用: 想用原生属性覆盖时以 attr 为准
	for (const [name, value] of Object.entries(define.attr ?? {})) {
		textarea.setAttribute(name, String(value));
	}
	textarea.addEventListener("input", () => {
		holder[define.id] = textarea.value;
		ctx.onValueChange();
	});
	field.append(textarea);

	return createLeafNode(define, holder, ctx, opts, el, () => {
		const value = holder[define.id];
		textarea.value = value === undefined || value === null ? "" : String(value);
	});
}

function buildSwitch(define, holder, ctx, opts) {
	const { el, field } = createFieldShell(define, opts);

	const button = document.createElement("button");
	button.type = "button";
	button.classList.add("dot-switch");
	button.setAttribute("role", "switch");

	const paint = (state) => {
		button.classList.toggle("dot-switch-on", state);
		button.classList.toggle("dot-switch-off", !state);
		button.setAttribute("aria-checked", state ? "true" : "false");
	};

	button.addEventListener("click", () => {
		holder[define.id] = !holder[define.id];
		paint(holder[define.id] === true);
		ctx.onValueChange();
	});
	field.append(button);

	return createLeafNode(define, holder, ctx, opts, el, () => {
		paint(holder[define.id] === true);
	});
}

/* ---------- 下拉选择 ---------- */

/** 浮层自增序号, 用于生成 option 的唯一 id */
let selectSeq = 0;
/** 当前展开的浮层关闭函数: 同一时刻只允许一个下拉展开 */
let closeActiveSelect = null;

/**
 * 下拉选择
 *
 * 原生 <select> 的弹出列表由浏览器/操作系统绘制, 其样式无法用 CSS 接管
 * (给 <option> 设 background 在多数平台根本不生效), 因此改为自绘:
 * 触发器是 <button>, 展开的列表是挂在 body 上的 fixed 浮层。
 *
 * 用 fixed 而非 absolute 是因为 #page-view 带 overflow: auto ——
 * absolute 浮层超出容器时会被裁切, 且因不参与布局而无法滚动到。
 */
function buildSelect(define, holder, ctx, opts) {
	const { el, field } = createFieldShell(define, opts);

	const items = (define.items ?? []).map((item) => ({
		label: item.label ?? String(item.value),
		value: String(item.value),
	}));
	const selectId = `config-select-${++selectSeq}`;

	const wrap = document.createElement("div");
	wrap.className = "config-select-wrap";

	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "config-select";
	trigger.setAttribute("role", "combobox");
	trigger.setAttribute("aria-haspopup", "listbox");
	trigger.setAttribute("aria-expanded", "false");

	const valueText = document.createElement("span");
	valueText.className = "config-select-value";
	const arrow = document.createElement("span");
	arrow.className = "config-select-arrow";
	trigger.append(valueText, arrow);
	wrap.append(trigger);
	field.append(wrap);

	/** 展开中的浮层 */
	let panel = null;
	/** 键盘高亮的下标 */
	let activeIndex = -1;
	/** 解绑本次展开注册的全局监听 */
	let detach = null;
	/** 键盘选中时刻: 浏览器可能仍合成一次 click, 用它避免面板立刻重开 */
	let pickedAt = 0;

	function selectedIndex() {
		const value = holder[define.id];
		const text = value === undefined || value === null ? "" : String(value);
		return items.findIndex((item) => item.value === text);
	}

	/** 把当前值刷到触发器上 (自绘控件不像原生 select 会自动跟值) */
	function paint() {
		const index = selectedIndex();
		valueText.textContent = index >= 0 ? items[index].label : "";
	}

	function close() {
		if (!panel) return;
		if (detach) detach();
		detach = null;
		panel.remove();
		panel = null;
		trigger.setAttribute("aria-expanded", "false");
		trigger.removeAttribute("aria-activedescendant");
		if (closeActiveSelect === close) closeActiveSelect = null;
	}

	function highlight(index) {
		if (!panel) return;
		const options = panel.children;
		if (options.length === 0) return;
		activeIndex = Math.max(0, Math.min(options.length - 1, index));
		for (let i = 0; i < options.length; i++) {
			options[i].classList.toggle("active", i === activeIndex);
		}
		const active = options[activeIndex];
		trigger.setAttribute("aria-activedescendant", active.id);
		active.scrollIntoView?.({ block: "nearest" });
	}

	function pick(index) {
		const item = items[index];
		if (!item) return;
		holder[define.id] = item.value;
		close();
		paint();
		ctx.onValueChange(); // 值变化可能改变其他控件的可见性
	}

	function position() {
		if (!panel) return;
		const rect = trigger.getBoundingClientRect();
		const height = panel.offsetHeight || 0;
		panel.style.width = `${rect.width}px`;
		panel.style.left = `${rect.left}px`;
		// 下方空间不足且上方更宽敞时向上展开
		if (rect.bottom + 4 + height > window.innerHeight && rect.top - 4 - height > 0) {
			panel.style.top = `${rect.top - height - 4}px`;
		} else {
			panel.style.top = `${rect.bottom + 4}px`;
		}
	}

	function open() {
		if (panel) return;
		if (closeActiveSelect) closeActiveSelect();

		const current = selectedIndex();
		panel = document.createElement("div");
		panel.className = "config-select-panel";
		panel.setAttribute("role", "listbox");

		items.forEach((item, index) => {
			const option = document.createElement("div");
			option.className = "config-select-option";
			option.id = `${selectId}-option-${index}`;
			option.setAttribute("role", "option");
			option.textContent = item.label;
			if (index === current) option.setAttribute("aria-selected", "true");
			option.addEventListener("click", () => pick(index));
			option.addEventListener("mouseenter", () => highlight(index));
			panel.append(option);
		});

		document.body.append(panel);
		trigger.setAttribute("aria-expanded", "true");
		position();
		highlight(current < 0 ? 0 : current);
		closeActiveSelect = close;

		const onPointerDown = (event) => {
			if (panel.contains(event.target) || trigger.contains(event.target)) return;
			close();
		};
		const onKeyDown = (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close();
			trigger.focus();
		};
		const onReflow = () => position();

		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", onReflow);
		// 捕获阶段监听所有滚动容器 (如 #page-view), 让浮层跟随触发器
		window.addEventListener("scroll", onReflow, true);

		detach = () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onReflow);
			window.removeEventListener("scroll", onReflow, true);
		};
	}

	trigger.addEventListener("click", () => {
		// 键盘选中后浏览器可能仍合成一次 click, 忽略它以免面板立刻重开
		if (Date.now() - pickedAt < 200) return;
		if (panel) close();
		else open();
	});

	trigger.addEventListener("keydown", (event) => {
		if (!panel) {
			// 未展开时 Enter / Space 交给浏览器默认行为 (button 会生成 click),
			// 只额外接管方向键与首末键的展开
			switch (event.key) {
				case "ArrowDown":
				case "ArrowUp":
					event.preventDefault();
					open();
					break;
				case "Home":
				case "End":
					event.preventDefault();
					open();
					highlight(event.key === "Home" ? 0 : items.length - 1);
					break;
				default:
					break;
			}
			return;
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				highlight(activeIndex + 1);
				break;
			case "ArrowUp":
				event.preventDefault();
				highlight(activeIndex - 1);
				break;
			case "Enter":
			case " ":
				// preventDefault 阻止浏览器随后合成的 click, 否则会与 click 处理重复响应
				event.preventDefault();
				pick(activeIndex);
				pickedAt = Date.now();
				break;
			case "Home":
				event.preventDefault();
				highlight(0);
				break;
			case "End":
				event.preventDefault();
				highlight(items.length - 1);
				break;
			case "Escape":
				event.preventDefault();
				close();
				break;
			case "Tab":
				close();
				break;
			default:
				break;
		}
	});

	return createLeafNode(define, holder, ctx, opts, el, paint);
}

function buildCheckbox(define, holder, ctx, opts) {
	const { el, field } = createFieldShell(define, opts);
	// 多选项竖向排列: 横排时选项一多就会折成参差不齐的几行
	field.classList.add("config-checkbox-group");

	const boxes = [];
	for (const item of define.items ?? []) {
		const itemLabel = document.createElement("label");
		itemLabel.className = "config-checkbox-item";

		const box = document.createElement("input");
		box.type = "checkbox";
		box.value = String(item.value);
		box.addEventListener("change", () => {
			const list = asArray(holder, define.id);
			const index = list.indexOf(box.value);
			if (box.checked && index < 0) list.push(box.value);
			else if (!box.checked && index >= 0) list.splice(index, 1);
			ctx.onValueChange();
		});

		itemLabel.append(box, document.createTextNode(item.label ?? String(item.value)));
		field.append(itemLabel);
		boxes.push(box);
	}

	return createLeafNode(define, holder, ctx, opts, el, () => {
		const list = asArray(holder, define.id);
		for (const box of boxes) box.checked = list.includes(box.value);
	});
}

/** 确保 holder 上的这个键是数组 (setValues 传入非法值时兜底) */
function asArray(holder, key) {
	if (!Array.isArray(holder[key])) holder[key] = [];
	return holder[key];
}

function buildSlider(define, holder, ctx, opts) {
	const { el, field } = createFieldShell(define, opts);

	const range = document.createElement("input");
	range.type = "range";
	range.className = "config-slider";
	if (define.min !== undefined) range.min = String(define.min);
	if (define.max !== undefined) range.max = String(define.max);
	if (define.step !== undefined) range.step = String(define.step);

	const readout = document.createElement("span");
	readout.className = "config-slider-value";

	range.addEventListener("input", () => {
		holder[define.id] = Number(range.value);
		readout.textContent = range.value;
		ctx.onValueChange();
	});
	field.append(range, readout);

	return createLeafNode(define, holder, ctx, opts, el, () => {
		const value = holder[define.id];
		if (typeof value !== "number" || Number.isNaN(value)) {
			holder[define.id] = defaultValueOf(define);
		}
		range.value = String(holder[define.id]);
		readout.textContent = range.value;
	});
}

function buildText(define, ctx, opts) {
	const el = document.createElement("div");
	el.classList.add("config-group", "config-text-box");

	const text = document.createElement("p");
	text.className = "config-text";
	text.textContent = define.label ?? define.desc ?? "";
	el.append(text);

	if (define.label && define.desc) {
		const desc = document.createElement("small");
		desc.className = "config-desc";
		desc.textContent = define.desc;
		el.append(desc);
	}

	return createInertNode(define, el, ctx, opts);
}

function buildGroup(define, holder, ctx, opts) {
	const key = define.id;
	if (!Object.prototype.hasOwnProperty.call(holder, key)) holder[key] = {};

	const { el, field } = createFieldShell(define, opts);
	field.classList.add("config-group-body");
	el.classList.add("config-group-box");

	const childHolder = holder[key];
	const children = (define.controls ?? []).map((control) =>
		buildControl(control, childHolder, ctx, opts)
	);
	for (const child of children) field.append(child.el);

	const node = {
		define,
		key,
		el,
		children,

		get: () => holder[key],

		collect(out) {
			if (!node.visible) return; // 隐藏分组整个不出现在取值结果里
			const nested = {};
			for (const child of children) child.collect(nested);
			out[key] = nested;
		},

		apply(value) {
			if (!value || typeof value !== "object") return; // 未提供则保留现有值
			for (const child of children) child.apply(value[child.key]);
		},

		validate(errors, path) {
			if (!node.visible) return;
			const next = path ? `${path}.${key}` : key;
			for (const child of children) child.validate(errors, next);
		},

		reset() {
			for (const child of children) child.reset();
		},
	};

	bindVisible(node, define, el, ctx, opts);
	registerNode(ctx, opts, key, node);

	return node;
}

function buildTable(define, holder, ctx, opts) {
	const key = define.id;
	const columns = define.controls ?? [];

	const { el, field } = createFieldShell(define, opts);
	field.classList.add("config-table-body");
	el.classList.add("config-table-box");

	const table = document.createElement("table");
	table.className = "config-table";

	const headRow = document.createElement("tr");
	for (const column of columns) {
		const th = document.createElement("th");
		th.textContent = column.label ?? column.id ?? "";
		headRow.append(th);
	}
	const headOp = document.createElement("th");
	headOp.className = "config-table-op";
	headRow.append(headOp);

	const thead = document.createElement("thead");
	thead.append(headRow);
	const tbody = document.createElement("tbody");
	table.append(thead, tbody);

	const addButton = createIconButton("/img/icons/add.svg", () => {
		addRow();
		ctx.onValueChange();
	})
	// addButton.classList.add("config-table-add")
	addButton.title = "添加行";

	field.append(table, addButton);

	/** @type {Array<{ holder: object, nodes: object[], tr: HTMLTableRowElement }>} */
	const rows = [];

	/**
	 * 追加一行
	 * @param {object} [data] 行初始数据; 缺失的键用列控件自身的 default 填充
	 */
	function addRow(data) {
		const rowHolder = {};
		for (const column of columns) {
			if (data && Object.prototype.hasOwnProperty.call(data, column.id)) {
				rowHolder[column.id] = clone(data[column.id]);
			}
		}

		const tr = document.createElement("tr");
		const nodes = [];
		for (const column of columns) {
			const td = document.createElement("td");
			// 行内控件的 id 只在行内作用域可见, 不登记到全局 registry
			const childNode = buildControl(column, rowHolder, ctx, INLINE_OPTS);
			td.append(childNode.el);
			tr.append(td);
			nodes.push(childNode);
		}

		const opCell = document.createElement("td");
		opCell.className = "config-table-op";
		const removeButton = document.createElement("button");
		removeButton.type = "button";
		removeButton.className = "icon-btn config-table-del";
		removeButton.title = "删除该行";
		removeButton.textContent = "×";
		opCell.append(removeButton);
		tr.append(opCell);

		const entry = { holder: rowHolder, nodes, tr };
		removeButton.addEventListener("click", () => removeRow(entry));

		rows.push(entry);
		tbody.append(tr);
		return entry;
	}

	function removeRow(entry) {
		const index = rows.indexOf(entry);
		if (index < 0) return;
		rows.splice(index, 1);
		entry.tr.remove();
		ctx.onValueChange();
	}

	function clearRows() {
		for (const entry of rows) entry.tr.remove();
		rows.length = 0;
	}

	const node = {
		define,
		key,
		el,
		rows,

		get: () => rows.map((entry) => entry.holder),

		collect(out) {
			if (!node.visible) return;
			out[key] = rows.map((entry) => {
				const row = {};
				for (const child of entry.nodes) child.collect(row);
				return row;
			});
		},

		apply(value) {
			clearRows();
			if (Array.isArray(value)) {
				for (const data of value) addRow(data);
			}
		},

		validate(errors, path) {
			if (!node.visible) return;
			const base = path ? `${path}.${key}` : key;
			rows.forEach((entry, index) => {
				for (const child of entry.nodes) {
					child.validate(errors, `${base}[${index}]`);
				}
			});
		},

		reset() {
			clearRows();
			// 未提供 default 时只保留表头
			for (const data of define.default ?? []) addRow(data);
		},
	};

	bindVisible(node, define, el, ctx, opts);
	registerNode(ctx, opts, key, node);

	// 初始行数据来自 default; 未提供时只有表头
	for (const data of define.default ?? []) addRow(data);

	return node;
}

/* ---------- visible 求值 ---------- */

/**
 * 求值 visible 表达式
 *
 * @param {boolean | object | undefined} expr 表达式 (schema.json 的 visible 定义)
 * @param {object} ctx 上下文
 * @param {number} depth 递归深度, 用于拦截自引用
 * @returns {boolean}
 */
function evalVisible(expr, ctx, depth) {
	if (depth > 32) {
		console.warn("[config] visible 表达式嵌套过深 (疑似循环引用), 按可见处理");
		return true;
	}
	if (expr === undefined || expr === null) return true;
	if (typeof expr === "boolean") return expr;
	if (typeof expr !== "object") return true;

	switch (expr.op) {
		case "and":
			return evalVisible(expr.left, ctx, depth + 1) && evalVisible(expr.right, ctx, depth + 1);
		case "or":
			return evalVisible(expr.left, ctx, depth + 1) || evalVisible(expr.right, ctx, depth + 1);
		case "not":
			return !evalVisible(expr.left, ctx, depth + 1);
		case "equal":
			return readRef(expr.ref, ctx) === expr.target;
		case "notEqual":
			return readRef(expr.ref, ctx) !== expr.target;
		case "gt":
			return readRef(expr.ref, ctx) > expr.target;
		case "gte":
			return readRef(expr.ref, ctx) >= expr.target;
		case "lt":
			return readRef(expr.ref, ctx) < expr.target;
		case "lte":
			return readRef(expr.ref, ctx) <= expr.target;
		case "in": {
			const target = expr.target;
			return Array.isArray(target) && target.includes(readRef(expr.ref, ctx));
		}
		case "notIn": {
			const target = expr.target;
			return !(Array.isArray(target) && target.includes(readRef(expr.ref, ctx)));
		}
		default:
			console.warn(`[config] 未知的 visible 运算符: ${expr.op}, 按可见处理`);
			return true;
	}
}

/** 读取 ref 指向的控件的当前值 */
function readRef(id, ctx) {
	const node = ctx.registry.get(id);
	if (!node) {
		console.warn(`[config] visible.ref 指向不存在的控件: ${id}`);
		return undefined;
	}
	return node.get();
}
