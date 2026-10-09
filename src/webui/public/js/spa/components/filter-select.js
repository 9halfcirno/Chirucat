/**
 * 下拉选择（单选 / 多选）
 *
 * 与 select.js 的分工：select 只表达"取一个值"，原生 <select> 也做不到多选；
 * 这里覆盖需要"任意组合勾选"的场景 —— 日志页的等级过滤、配置表单里项数偏多的
 * checkbox（见 config-editor.js 的 MAX_INLINE_CHECKBOX_ITEMS）。
 * DOM 结构与 class 完全沿用 select.js
 * （样式来自 css/components/config-editor.css 的 .config-select* 与
 * .config-checkbox-item，均由 index.html 全局加载），控件之间看不出差别。
 *
 * 浮层同样挂 body + fixed：#page-view 带 overflow: auto，
 * absolute 浮层超出容器会被裁切且滚不到。
 *
 * 两种模式的选中态表达分开：
 * - 单选走 aria-selected，与 select.js 一致（当前项高亮成主题色）
 * - 多选走复选框，且点选后不关浮层，便于连续勾选
 */

/** 浮层自增序号，用于生成 option 的唯一 id */
let filterSeq = 0;
/** 当前展开的浮层关闭函数：同一时刻只允许一个过滤浮层展开 */
let closeActiveFilter = null;

/**
 * 创建一个下拉选择
 *
 * @param {object} [opts]
 * @param {{ label?: string, value: string | number }[]} [opts.items] 可选项
 * @param {string | number | (string | number)[]} [opts.values] 初始选中值；
 *   多选模式传数组，单选模式传单值（空串表示"不限定"）
 * @param {boolean} [opts.multiple] 多选模式
 * @param {string} [opts.allLabel] 多选模式下全部选中时的摘要文案
 * @param {(selected: string | string[]) => void} [opts.onChange] 选中变化回调；
 *   单选回传字符串值，多选回传值数组
 * @returns {{
 *   el: HTMLElement,
 *   getValues: () => string | string[],
 *   setValues: (value: unknown) => void,
 *   setItems: (items: { label?: string, value: string | number }[]) => void,
 *   close: () => void,
 * }}
 */
export function createFilterSelect({
	items: initialItems = [],
	values: initialValues = [],
	multiple = false,
	allLabel = "全部",
	onChange,
} = {}) {
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

	const selectId = `config-filter-${++filterSeq}`;

	/** 可选项 */
	let items = normalizeItems(initialItems);
	/** 多选模式的选中集（保留的值可能不在 items 里，如已删除的 Bot） */
	let selected = new Set(toValueList(initialValues));
	/** 单选模式的当前值 */
	let current = multiple ? "" : (toValueList(initialValues)[0] ?? "");

	/** 展开中的浮层 */
	let panel = null;
	/** 浮层里的选项，与 items 同序；box 仅多选模式有值 */
	let options = [];
	/** 键盘高亮的下标 */
	let activeIndex = -1;
	/** 解绑本次展开注册的全局监听 */
	let detach = null;
	/** 键盘选中时刻：浏览器可能仍合成一次 click，用它避免面板立刻重开 */
	let pickedAt = 0;

	/** 多选模式下当前项集里被勾中的项（按 items 顺序） */
	function pickedItems() {
		return items.filter(item => selected.has(item.value));
	}

	function selectedIndex() {
		return items.findIndex(item => item.value === current);
	}

	/** 把选中态刷到触发器：单选显示当前项，多选显示摘要 */
	function paint() {
		if (!multiple) {
			const index = selectedIndex();
			valueText.textContent = index >= 0 ? items[index].label : "";
			return;
		}

		const picked = pickedItems();
		if (items.length && picked.length === items.length && selected.size === items.length) {
			valueText.textContent = allLabel;
		} else if (!picked.length) {
			// 一个可见项都没勾：要么真的清空了，要么只剩不在列表里的历史值
			valueText.textContent = selected.size ? `已选 ${selected.size} 项` : "无";
		} else if (picked.length <= 2) {
			valueText.textContent = picked.map(item => item.label).join(" / ");
		} else {
			valueText.textContent = `已选 ${picked.length} 项`;
		}
	}

	/** 选中集变化后统一收尾：重绘触发器并通知调用方 */
	function emit() {
		paint();
		onChange?.(multiple ? [...selected] : current);
	}

	function close() {
		if (!panel) return;
		if (detach) detach();
		detach = null;
		panel.remove();
		panel = null;
		options = [];
		trigger.setAttribute("aria-expanded", "false");
		trigger.removeAttribute("aria-activedescendant");
		if (closeActiveFilter === close) closeActiveFilter = null;
	}

	/** 把选中态同步到浮层（多选点选后只改一项，不必整表重建） */
	function paintOption(index) {
		const entry = options[index];
		const item = items[index];
		if (!entry || !item) return;
		if (multiple) entry.box.checked = selected.has(item.value);
		else entry.el.setAttribute("aria-selected", String(item.value === current));
	}

	function highlight(index) {
		if (!panel) return;
		const els = panel.children;
		if (els.length === 0) return;
		activeIndex = Math.max(0, Math.min(els.length - 1, index));
		for (let i = 0; i < els.length; i++) {
			els[i].classList.toggle("active", i === activeIndex);
		}
		const active = els[activeIndex];
		trigger.setAttribute("aria-activedescendant", active.id);
		active.scrollIntoView?.({ block: "nearest" });
	}

	/** 落到某一项：单选即关闭，多选保持展开以便连续勾选 */
	function pick(index) {
		const item = items[index];
		if (!item) return;

		if (multiple) {
			if (selected.has(item.value)) selected.delete(item.value);
			else selected.add(item.value);
			paintOption(index);
			emit();
			return;
		}

		current = item.value;
		close();
		paint();
		onChange?.(current);
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
		if (closeActiveFilter) closeActiveFilter();

		panel = document.createElement("div");
		panel.className = "config-select-panel";
		panel.setAttribute("role", "listbox");

		options = items.map((item, index) => {
			const el = document.createElement("div");
			el.className = "config-select-option";
			el.id = `${selectId}-option-${index}`;
			el.setAttribute("role", "option");

			let box = null;
			if (multiple) {
				// 复选框只表达状态: 点它事件会冒泡到整行, 统一由 pick 改状态再回写 checked
				box = document.createElement("input");
				box.type = "checkbox";
				box.checked = selected.has(item.value);
				const row = document.createElement("span");
				row.className = "config-checkbox-item";
				const label = document.createElement("span");
				label.textContent = item.label;
				row.append(box, label);
				el.append(row);
			} else {
				el.textContent = item.label;
				el.setAttribute("aria-selected", String(item.value === current));
			}

			el.addEventListener("click", () => pick(index));
			el.addEventListener("mouseenter", () => highlight(index));
			panel.append(el);
			return { el, box };
		});

		document.body.append(panel);
		trigger.setAttribute("aria-expanded", "true");
		position();
		highlight(multiple ? 0 : Math.max(0, selectedIndex()));
		closeActiveFilter = close;

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
		// 捕获阶段监听所有滚动容器 (如 #page-view)，让浮层跟随触发器
		window.addEventListener("scroll", onReflow, true);

		detach = () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onReflow);
			window.removeEventListener("scroll", onReflow, true);
		};
	}

	trigger.addEventListener("click", () => {
		// 键盘选中后浏览器可能仍合成一次 click，忽略它以免面板立刻重开
		if (Date.now() - pickedAt < 200) return;
		if (panel) close();
		else open();
	});

	trigger.addEventListener("keydown", (event) => {
		if (!panel) {
			// 未展开时 Enter / Space 交给浏览器默认行为 (button 会生成 click)，
			// 只额外接管方向键与首末键的展开
			switch (event.key) {
				case "ArrowDown":
				case "ArrowUp":
				case "Home":
				case "End":
					event.preventDefault();
					open();
					if (event.key === "Home") highlight(0);
					else if (event.key === "End") highlight(items.length - 1);
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
				// preventDefault 阻止浏览器随后合成的 click，否则会与 click 处理重复响应
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
			case "Tab":
				close();
				break;
			default:
				break;
		}
	});

	paint();

	return {
		el: wrap,
		getValues: () => (multiple ? [...selected] : current),
		setValues(next) {
			if (multiple) selected = new Set(toValueList(next));
			else current = next === undefined || next === null ? "" : String(next);
			// 浮层展开中改值要同步重绘，否则勾选态与触发器会不一致
			if (panel) items.forEach((_item, index) => paintOption(index));
			paint();
		},
		setItems(next) {
			items = normalizeItems(next);
			// 列表换掉后旧下标失效，收起浮层由调用方重新展开
			if (panel) close();
			paint();
		},
		close,
	};
}

/** 规整选项：统一成 { label, value } 且 value 为字符串 */
function normalizeItems(list) {
	return (list ?? []).map(item => ({
		label: item.label ?? String(item.value),
		value: String(item.value),
	}));
}

/** 规整选中值：统一成非空字符串数组（单选模式的空值列表即"不限定"） */
function toValueList(value) {
	const list = Array.isArray(value) ? value : [value];
	return list
		.filter(item => item !== undefined && item !== null && item !== "")
		.map(item => String(item));
}
