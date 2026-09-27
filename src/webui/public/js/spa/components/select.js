/**
 * 自绘下拉选择
 *
 * 原生 <select> 的弹出列表由浏览器/操作系统绘制, 其样式无法用 CSS 接管
 * (给 <option> 设 background 在多数平台根本不生效), 因此改为自绘:
 * 触发器是 <button>, 展开的列表是挂在 body 上的 fixed 浮层。
 *
 * 用 fixed 而非 absolute 是因为 #page-view 带 overflow: auto ——
 * absolute 浮层超出容器时会被裁切, 且因不参与布局而无法滚动到。
 *
 * 样式沿用 .config-select* (定义在 css/components/config-editor.css, 由
 * index.html 全局加载), 因此任何页面都可以直接使用本组件。
 */

/** 浮层自增序号, 用于生成 option 的唯一 id */
let selectSeq = 0;
/** 当前展开的浮层关闭函数: 同一时刻只允许一个下拉展开 */
let closeActiveSelect = null;

/**
 * 创建一个下拉选择
 *
 * @param {object} [opts]
 * @param {{ label?: string, value: string | number }[]} [opts.items] 选项
 * @param {string | number} [opts.value] 初始值
 * @param {(value: string) => void} [opts.onChange] 选中回调
 * @returns {{
 *   el: HTMLElement,
 *   getValue: () => string,
 *   setValue: (value: unknown) => void,
 *   setItems: (items: { label?: string, value: string | number }[]) => void,
 *   close: () => void,
 * }}
 */
export function createSelect({ items: initialItems = [], value = "", onChange } = {}) {
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

	const selectId = `config-select-${++selectSeq}`;

	/** 选项列表 */
	let items = normalizeItems(initialItems);
	/** 当前值 */
	let current = value === undefined || value === null ? "" : String(value);

	/** 展开中的浮层 */
	let panel = null;
	/** 键盘高亮的下标 */
	let activeIndex = -1;
	/** 解绑本次展开注册的全局监听 */
	let detach = null;
	/** 键盘选中时刻: 浏览器可能仍合成一次 click, 用它避免面板立刻重开 */
	let pickedAt = 0;

	function selectedIndex() {
		return items.findIndex(item => item.value === current);
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
		if (closeActiveSelect) closeActiveSelect();

		const currentIndex = selectedIndex();
		panel = document.createElement("div");
		panel.className = "config-select-panel";
		panel.setAttribute("role", "listbox");

		items.forEach((item, index) => {
			const option = document.createElement("div");
			option.className = "config-select-option";
			option.id = `${selectId}-option-${index}`;
			option.setAttribute("role", "option");
			option.textContent = item.label;
			if (index === currentIndex) option.setAttribute("aria-selected", "true");
			option.addEventListener("click", () => pick(index));
			option.addEventListener("mouseenter", () => highlight(index));
			panel.append(option);
		});

		document.body.append(panel);
		trigger.setAttribute("aria-expanded", "true");
		position();
		highlight(currentIndex < 0 ? 0 : currentIndex);
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

	paint();

	return {
		el: wrap,
		getValue: () => current,
		setValue(next) {
			current = next === undefined || next === null ? "" : String(next);
			paint();
		},
		setItems(next) {
			items = normalizeItems(next);
			if (panel) close();
			paint();
		},
		close,
	};
}

/** 规整选项: 统一成 { label, value } 且 value 为字符串 */
function normalizeItems(list) {
	return (list ?? []).map(item => ({
		label: item.label ?? String(item.value),
		value: String(item.value),
	}));
}
