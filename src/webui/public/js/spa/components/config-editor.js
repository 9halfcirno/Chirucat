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
import { createSelect } from "./select.js";

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

/**
 * 建立一个控件外壳: label + 控件槽 + desc
 *
 * @param {HTMLElement[]} [headExtras] 与 label 并排放在标题行里的元素 (如折叠按钮)。
 * 	传入时会额外包一层 .config-group-head; 不传则 label 直挂, 其余控件的 DOM 不变。
 */
function createFieldShell(define, opts, headExtras) {
	const el = document.createElement("div");
	el.classList.add("config-group");
	if (define.id) el.dataset.id = define.id;

	if (!opts.inline && define.label) {
		const extras = headExtras ?? [];
		if (extras.length === 0) {
			el.append(createLabel(define));
		} else {
			const head = document.createElement("div");
			head.className = "config-group-head";
			head.append(createLabel(define));
			for (const extra of extras) head.append(extra);
			el.append(head);
		}
	}

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

/** 下拉选择: 自绘实现见 components/select.js */
function buildSelect(define, holder, ctx, opts) {
	const { el, field } = createFieldShell(define, opts);

	// 自绘下拉的实现在 components/select.js, 这里只做「控件定义 <-> 表单值」的适配
	const select = createSelect({
		items: define.items ?? [],
		value: holder[define.id],
		// 值变化可能改变其他控件的可见性
		onChange: (value) => {
			holder[define.id] = value;
			ctx.onValueChange();
		},
	});
	field.append(select.el);

	return createLeafNode(define, holder, ctx, opts, el, () => {
		select.setValue(holder[define.id]);
	});
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

/* ---------- 表格折叠 ---------- */

/** 折叠区域的 DOM id 序号 */
let tableSeq = 0;

function buildTable(define, holder, ctx, opts) {
	const key = define.id;
	const columns = define.controls ?? [];
	const bodyId = `config-table-${++tableSeq}`;

	// 折叠按钮与表项数要和 label 同处标题行, 因此必须在建立外壳之前先创建
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "config-table-toggle";
	toggle.setAttribute("aria-controls", bodyId);
	toggle.setAttribute("aria-expanded", "true");
	toggle.setAttribute("aria-label", "折叠");
	toggle.title = "折叠 / 展开";

	const count = document.createElement("div");
	count.className = "config-table-count";

	const { el, field } = createFieldShell(define, opts, [toggle, count]);
	field.classList.add("config-table-body");
	field.id = bodyId;
	el.classList.add("config-table-box");

	const table = document.createElement("table");
	table.className = "config-table";

	const headRow = document.createElement("tr");
	for (const column of columns) {
		const th = document.createElement("th");
		let label = createLabel(column);
		th.append(label);
		// th.textContent = column.label ?? column.id ?? "";
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

	// 表格外面套一层滚动容器: 窄屏时横向滚动, 而不是把外层容器撑破
	const scroller = document.createElement("div");
	scroller.className = "config-table-scroll";
	scroller.append(table);

	field.append(scroller, addButton);

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
		updateCount();
		return entry;
	}

	function removeRow(entry) {
		const index = rows.indexOf(entry);
		if (index < 0) return;
		rows.splice(index, 1);
		entry.tr.remove();
		updateCount();
		ctx.onValueChange();
	}

	function clearRows() {
		for (const entry of rows) entry.tr.remove();
		rows.length = 0;
		updateCount();
	}

	/** 折叠时展示的表项数 */
	function updateCount() {
		count.textContent = rows.length === 0 ? "暂无表项" : `共 ${rows.length} 项`;
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

	/* ---- 折叠 / 展开 ---- */

	/**
	 * 用实测的 scrollHeight 驱动高度过渡。
	 * 固定一个很大的 max-height 上界时, 内容远小于上界会让前大半段动画“空走”, 看起来像卡住。
	 *
	 * @param {boolean} collapsed
	 */
	function setCollapsed(collapsed) {
		el.classList.toggle("collapsed", collapsed);
		toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
		toggle.setAttribute("aria-label", collapsed ? "展开" : "折叠");

		const height = field.scrollHeight || 0;
		if (collapsed) {
			field.style.maxHeight = `${height}px`;
			void field.offsetHeight; // 先落到起始高度, 否则浏览器不会产生过渡
			field.style.maxHeight = "0px";
			field.style.opacity = "0";
		} else {
			field.style.maxHeight = `${height}px`;
			field.style.opacity = "1";
		}
	}

	toggle.addEventListener("click", () => {
		setCollapsed(!el.classList.contains("collapsed"));
	});

	// 展开动画结束后解除高度限制, 否则之后增删行会被裁掉
	field.addEventListener("transitionend", (event) => {
		if (event.propertyName !== "max-height") return;
		if (!el.classList.contains("collapsed")) field.style.maxHeight = "none";
	});

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
			if (!Array.isArray(target)) return false;
			const value = readRef(expr.ref, ctx);
			if (Array.isArray(value)) {
				// 多选 (checkbox): 当前值数组与 target 有交集即命中
				return value.some((v) => target.includes(v));
			}
			return target.includes(value);
		}
		case "notIn": {
			const target = expr.target;
			if (!Array.isArray(target)) return true;
			const value = readRef(expr.ref, ctx);
			if (Array.isArray(value)) {
				return !value.some((v) => target.includes(v));
			}
			return !target.includes(value);
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
