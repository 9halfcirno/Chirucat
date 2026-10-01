/**
 * 测试页面 (TestLab) — 手动验证面板
 *
 * 两块内容:
 *
 * 1. **核心重启**: 验证"后端断连后前端不崩"(重启请求必然失败, 错误被吞掉)
 * 2. **SPA 动态菜单**: 把框架的运行期增删接口全摆成按钮, 点一下就能看到
 *    活动栏 (一级导航) 与侧栏 (二级菜单) 的即时变化, 并把等价的 API 调用
 *    记在"调用日志"里
 *
 * 演示覆盖:
 *
 * - 一级导航: `register` (内联页面, 没有 js 文件)、`update` (改标题 / 调顺序)、
 *   `unregister` (注销当前页会落到第一个页面)、`listPages`
 * - 二级菜单: `add` (追加 / 指定位置 / 文本项 / 同 id 更新)、`set` (整表替换)、
 *   `remove` (按 id / 按下标)、`select`、`refresh` (重读页面声明)、
 *   `reset` (丢动态状态回到声明式)、`list`
 * - 按页面记账: 二级菜单操作一律显式带 `{ page }`, 所以"给没打开的页面预埋
 *   菜单"也能演示 (见"给日志页预埋"那张卡片)
 *
 * 页面 id / 标题 / 图标与菜单的完整语义见 docs/webui/spa.md。
 */
import { apiFetch } from "../../spa/auth.js";
import { createButton } from "../../spa/components/button.js";
import toast from "../../spa/toast.js";

/** 本页在框架里的注册 id: 下面的二级菜单操作都显式指定它 (演示"按页面记账") */
const PAGE = "test";

/** 预埋到日志页的菜单项 id (演示跨页面增删时用来删掉它们) */
const prefillIds = [];

/** 本页**声明式**的二级菜单: 就是页面模块的 sidebar 字段, refresh() 会重读它 */
const declaredSidebar = [
	{
		title: "项一",
		render(el) {
			el.innerHTML = `<h2>项一</h2><p class="muted">页面声明式菜单项: 来自 sidebar 数组。</p>`;
		},
	},
	{
		title: "项二",
		render(el) {
			el.innerHTML = `<h2>项二</h2><p class="muted">删除它再 refresh: 不会回来 (抑制表); reset 之后才回来。</p>`;
		},
	},
	"测试",
	{
		title: "项三",
		render(el) {
			el.innerHTML = `<h2>项三</h2><p class="muted">文本项 (上面的"测试") 不可点击, 会自动跳过。</p>`;
		},
	},
];

// 运行期生成的名字/页面 id 从这里取号, 免得重名互相覆盖
let itemSeq = 0;
let declSeq = 0;
let labSeq = 0;
/** 最近一次注册的实验页 id; null = 还没注册 */
let labId = null;

export default {
	id: PAGE,
	title: "测试页面",
	styles: ["/js/pages/test/test.css"],
	sidebar: declaredSidebar,

	/**
	 * @param {HTMLDivElement} container 页面容器 (.spa-page)
	 * @param {object} app SPA 应用对象 (框架传入, 动态菜单全靠它)
	 */
	render(container, app) {
		container.replaceChildren();

		const wrap = document.createElement("div");
		wrap.className = "test-page";

		const head = document.createElement("h2");
		head.textContent = `欢迎来到 Chirucat WebUI 实验室!`;

		const note = document.createElement("p");
		note.className = "muted";
		note.textContent = "下面每个按钮都对应一次框架 API 调用: 活动栏 (一级导航) 与左侧侧栏 (二级菜单) 会立即变化, 等价的调用记在最下方的日志里。";

		wrap.append(head, note);
		container.appendChild(wrap);

		// ---- 反馈区 (先建出来, 各卡片里的回调都往这里写) ----
		const snapshot = document.createElement("ol");
		snapshot.className = "test-snapshot";
		const navLine = document.createElement("p");
		navLine.className = "test-meta muted";
		const logBox = document.createElement("div");
		logBox.className = "test-log";
		const logEmpty = document.createElement("p");
		logEmpty.className = "muted test-log-empty";
		logEmpty.textContent = "还没有调用。点下面的按钮试试。";
		logBox.appendChild(logEmpty);

		/** 记一行调用日志 (新的在最上面) */
		function log(text) {
			logEmpty.remove();
			const line = document.createElement("div");
			line.className = "test-log-line";

			const time = document.createElement("span");
			time.className = "test-log-time";
			time.textContent = new Date().toLocaleTimeString();

			const body = document.createElement("span");
			body.className = "test-log-body mono";
			body.textContent = text;

			line.append(time, body);
			logBox.prepend(line);
		}

		/** 刷新反馈区: 二级菜单快照 + 一级导航现状 */
		function refreshPanels() {
			const items = app.sidebar.list({ page: PAGE });

			if (items.length === 0) {
				const li = document.createElement("li");
				li.className = "muted";
				li.textContent = "(本页当前没有菜单项 —— 侧栏已整块隐藏)";
				snapshot.replaceChildren(li);
			} else {
				snapshot.replaceChildren(...items.map((item) => {
					const li = document.createElement("li");
					if (item.kind === "label") li.className = "is-label";
					li.textContent = `${item.title} ⟨${item.kind === "label" ? "文本项" : "可点击"}${item.render ? "" : " · 无内容"} · id=${item.id}⟩`;
					return li;
				}));
			}

			navLine.textContent = `当前页面: ${app.sidebar.currentPageId() ?? "无"} · 一级导航: `
				+ app.listPages().map((p) => `${p.title}[${p.id}]`).join(" → ");
		}

		/** 造一张卡片: 标题 + 说明 + 一排按钮 */
		function card(title, desc, buttons = []) {
			const box = document.createElement("section");
			box.className = "card test-card";

			const h = document.createElement("h3");
			h.textContent = title;
			box.appendChild(h);

			if (desc) {
				const p = document.createElement("p");
				p.className = "muted";
				p.textContent = desc;
				box.appendChild(p);
			}

			if (buttons.length > 0) {
				const row = document.createElement("div");
				row.className = "test-actions";
				row.append(...buttons);
				box.appendChild(row);
			}

			wrap.appendChild(box);
			return box;
		}

		/**
		 * 造一个运行期菜单项
		 *
		 * 项内容里也放一个"删掉自己"的按钮: 演示菜单项能直接操作自己所在的菜单。
		 */
		function demoItem(id, title) {
			return {
				id,
				title,
				render(el) {
					const h = document.createElement("h3");
					h.textContent = title;

					const p = document.createElement("p");
					p.className = "muted";
					p.textContent = `运行期 add() 进来的菜单项, id = ${id}。`;

					const btn = createButton("在内容里删掉自己", () => {
						app.sidebar.remove(id, { page: PAGE });
						log(`sidebar.remove("${id}", { page: "${PAGE}" }) ← 由菜单项内容自己调用`);
						refreshPanels();
					});

					el.replaceChildren(h, p, btn);
				},
			};
		}

		/** 实验页的正文: 演示"动态注册的页面"自己也能挂菜单 / 注销自己 */
		function renderLab(el, api, id, seq) {
			const h = document.createElement("h3");
			h.textContent = `我是运行期注册的内联页面 (id=${id})`;

			const p = document.createElement("p");
			p.className = "muted";
			p.textContent = "没有对应的 js 文件: register() 时直接给了 render()。下面两个按钮操作的是我自己。";

			const row = document.createElement("div");
			row.className = "test-actions";
			let n = 0;

			row.append(
				createButton("给自己加一项二级菜单", async () => {
					n++;
					const item = api.sidebar.add({
						id: `${id}-item-${n}`,
						title: `实验页项 ${n}`,
						render(c) {
							c.textContent = `实验页 ${seq} 的运行期菜单项 ${n}`;
						},
					}, { page: id });
					await api.sidebar.select(item.id, { page: id });
					// 注意: 本页离开 TestLab 后, TestLab 的日志区已经脱离文档,
					// 所以这里的反馈用 toast (全局可见) 而不是写日志
					toast(`已给本页 add 一项二级菜单: 实验页项 ${n}`, { type: "info" });
				}),
				createButton("从本页注销自己", () => {
					api.unregister(id);
					if (labId === id) labId = null;
					toast(`已 unregister("${id}"): 当前页面被注销, 落到剩下的第一个页面`, { type: "warn" });
				}),
			);

			el.append(h, p, row);
		}

		/** 需要实验页存在的按钮: 没有就提示 (而不是抛错) */
		function withLab(fn) {
			return () => {
				if (!labId || !app.hasPage(labId)) {
					toast("先点 [注册实验页]", { type: "warn" });
					return;
				}
				fn(labId);
			};
		}

		// ==================== 反馈区 ====================

		const snapCard = card("现状", "左侧侧栏与活动栏就是结果, 这里把它们的数据源摊开:", []);
		snapCard.append(navLine, snapshot);

		const logCard = card("调用日志", "每次点击都把等价的 API 调用记在这里 (新的在最上面):", [
			createButton("清空日志", () => {
				logBox.replaceChildren(logEmpty);
			}),
		]);
		logCard.append(logBox);

		// ==================== 一级导航 ====================

		card(
			"一级导航 · 运行期增删页面",
			"register 之后活动栏立刻多一个按钮, 点它就能进来; update 改标题/调顺序; unregister 注销 (注销当前页会落到第一个页面)。",
			[
				createButton("注册实验页", () => {
					labSeq++;
					const seq = labSeq;
					const id = `lab-${seq}`;
					labId = id;
					app.register({
						id,
						title: `实验页 ${seq}`,
						icon: "/img/icons/test.svg",
						// 内联页面: 没有模块文件, register 时直接把 render 给出去
						render(el, api) { renderLab(el, api, id, seq); },
						sidebar: [{
							title: "实验页自带的项",
							render(el) { el.textContent = "我是注册实验页时声明在 sidebar 里的项"; },
						}],
					});
					log(`register({ id: "${id}", title: "实验页 ${seq}", render, sidebar: [...] })`);
					refreshPanels();
				}),
				createButton("改标题 (update)", withLab((id) => {
					const def = app.getPage(id);
					const next = def.title.endsWith("*") ? def.title.slice(0, -1) : `${def.title}*`;
					app.update(id, { title: next });
					log(`update("${id}", { title: "${next}" })`);
					refreshPanels();
				})),
				createButton("挪到第一位", withLab((id) => {
					app.update(id, { index: 0 });
					log(`update("${id}", { index: 0 })`);
					refreshPanels();
				})),
				createButton("挪到末尾", withLab((id) => {
					app.update(id, { index: app.listPages().length - 1 });
					log(`update("${id}", { index: ${app.listPages().length - 1} })`);
					refreshPanels();
				})),
				createButton("注销实验页 (unregister)", withLab((id) => {
					const wasCurrent = app.sidebar.currentPageId() === id;
					app.unregister(id);
					labId = null;
					log(`unregister("${id}")${wasCurrent ? " ← 注销的是当前页面: 已落到第一个页面" : ""}`);
					refreshPanels();
				})),
			]
		);

		// ==================== 二级菜单: 增 / 改 ====================

		card(
			"二级菜单 · 新增与更新",
			`菜单按页面 id 记账 (这里显式带 { page: "${PAGE}" }): 同 id 视为同一条菜单, 再 add 就是更新它。`
			+ " (菜单项的内容由框架接在页面骨架之后, 也就是本页最下方; 点开某项后滚到底部看)",
			[
				createButton("追加一项 (add)", async () => {
					itemSeq++;
					const id = `demo-${itemSeq}`;
					const item = app.sidebar.add(demoItem(id, `动态项 ${itemSeq}`), { page: PAGE });
					log(`sidebar.add({ id: "${id}", title: "动态项 ${itemSeq}" }, { page: "${PAGE}" })`);
					await app.sidebar.select(item.id, { page: PAGE });
					refreshPanels();
				}),
				createButton("插到第 2 位 (index)", () => {
					itemSeq++;
					const id = `demo-${itemSeq}`;
					app.sidebar.add(demoItem(id, `插队项 ${itemSeq}`), { page: PAGE, index: 1 });
					log(`sidebar.add({ id: "${id}" }, { page: "${PAGE}", index: 1 })`);
					refreshPanels();
				}),
				createButton("加文本分组 (字符串项)", () => {
					declSeq++;
					app.sidebar.add(`动态分组 ${declSeq}`, { page: PAGE });
					log(`sidebar.add("动态分组 ${declSeq}", { page: "${PAGE}" }) ← 字符串 = 不可点的文本项`);
					refreshPanels();
				}),
				createButton("同 id 更新首项", () => {
					const first = app.sidebar.list({ page: PAGE })[0];
					if (!first) {
						toast("当前没有菜单项可更新", { type: "warn" });
						return;
					}
					if (first.kind === "label") {
						// 文本项要按字符串加回去, 否则会变成"没有内容的可点击项"
						app.sidebar.add(`${first.title}*`, { page: PAGE });
					} else {
						app.sidebar.add({ id: first.id, title: `${first.title}*`, render: first.render }, { page: PAGE });
					}
					log(`sidebar.add({ id: "${first.id}", title: "${first.title}*" }) ← 同 id: 就地更新, 位置不变`);
					refreshPanels();
				}),
				createButton("往页面声明数组追加 + refresh", () => {
					declSeq++;
					declaredSidebar.push({
						title: `声明项 ${declSeq}`,
						render(el) { el.textContent = `我是后来 push 进页面 sidebar 数组的声明式项 ${declSeq}`; },
					});
					app.sidebar.refresh({ page: PAGE });
					log(`declaredSidebar.push(...) + sidebar.refresh({ page: "${PAGE}" })`);
					refreshPanels();
				}),
				createButton("set 整表替换", async () => {
					itemSeq++;
					const first = demoItem(`set-${itemSeq}`, `set 项 ${itemSeq}`);
					itemSeq++;
					const second = demoItem(`set-${itemSeq}`, `set 项 ${itemSeq}`);
					app.sidebar.set([first, "set 里的文本项", second], { page: PAGE });
					log(`sidebar.set([...3 项], { page: "${PAGE}" }) ← 声明式 sidebar 从此让位, 直到 reset`);
					await app.sidebar.select(first.id, { page: PAGE });
					refreshPanels();
				}),
			]
		);

		// ==================== 二级菜单: 删 / 选 / 回退 ====================

		card(
			"二级菜单 · 删除、选中与回退",
			"删除会记住被删的 id: 页面重新声明 (refresh) 时它不会自己冒回来; reset 丢掉全部动态状态后才回来。",
			[
				createButton("删首项 (按 id)", () => {
					const first = app.sidebar.list({ page: PAGE })[0];
					if (!first) {
						toast("当前没有菜单项", { type: "warn" });
						return;
					}
					const ok = app.sidebar.remove(first.id, { page: PAGE });
					log(`sidebar.remove("${first.id}", { page: "${PAGE}" }) → ${ok}`);
					refreshPanels();
				}),
				createButton("删末项 (按下标)", () => {
					const items = app.sidebar.list({ page: PAGE });
					if (items.length === 0) {
						toast("当前没有菜单项", { type: "warn" });
						return;
					}
					const last = items.length - 1;
					const ok = app.sidebar.remove(last, { page: PAGE });
					log(`sidebar.remove(${last}, { page: "${PAGE}" }) → ${ok} ← 按下标删`);
					refreshPanels();
				}),
				createButton("选中第 2 项 (select)", async () => {
					const items = app.sidebar.list({ page: PAGE });
					if (items.length < 2) {
						toast("至少需要两项", { type: "warn" });
						return;
					}
					const target = items[1];
					const picked = await app.sidebar.select(target.id, { page: PAGE });
					log(`sidebar.select("${target.id}", { page: "${PAGE}" }) → ${picked ? "已选中并渲染内容" : "文本项不可选中"}`);
					refreshPanels();
				}),
				createButton("refresh (重读页面声明)", () => {
					app.sidebar.refresh({ page: PAGE });
					log("sidebar.refresh() ← 重读页面 sidebar 数组, 被删过的声明项仍不回来 (抑制表)");
					refreshPanels();
				}),
				createButton("reset (回到声明式)", () => {
					app.sidebar.reset({ page: PAGE });
					log("sidebar.reset() ← 丢掉动态状态与抑制表: 声明项全回来, 动态项全消失");
					refreshPanels();
				}),
			]
		);

		// ==================== 跨页面 ====================

		card(
			"二级菜单 · 给没打开的页面预埋",
			"下面操作的是[日志]页的菜单: 现在看不出变化, 打开日志页就会多出一项 —— 页面没开着也能增删 (先记账, 打开时渲染)。",
			[
				createButton("给日志页预埋一项", () => {
					itemSeq++;
					const id = `prefill-${itemSeq}`;
					prefillIds.push(id);
					app.sidebar.add({
						id,
						title: `预埋项 ${itemSeq} (来自 TestLab)`,
						render(el, api) {
							const h = document.createElement("h3");
							h.textContent = "这一项是 TestLab 预埋到日志页的";
							const p = document.createElement("p");
							p.className = "muted";
							p.textContent = "日志页本身没有声明过它: 它只存在于侧栏的菜单表里。";
							const btn = createButton("删掉自己", () => {
								api.sidebar.remove(id, { page: "logs" });
								toast("已从日志页的菜单里删掉", { type: "info" });
							});
							el.replaceChildren(h, p, btn);
						},
					}, { page: "logs" });
					log(`sidebar.add({ id: "${id}" }, { page: "logs" }) → 日志页现有 ${app.sidebar.list({ page: "logs" }).length} 项`);
					refreshPanels();
				}),
				createButton("删掉日志页预埋项", () => {
					const id = prefillIds.pop();
					if (!id) {
						toast("还没有预埋过", { type: "warn" });
						return;
					}
					const ok = app.sidebar.remove(id, { page: "logs" });
					log(`sidebar.remove("${id}", { page: "logs" }) → ${ok}`);
					refreshPanels();
				}),
				createButton("查看日志页菜单 (list)", () => {
					const titles = app.sidebar.list({ page: "logs" }).map((i) => i.title);
					log(`sidebar.list({ page: "logs" }) → ${JSON.stringify(titles)}`);
					refreshPanels();
				}),
			]
		);

		// ==================== 原有: 核心重启 ====================

		card(
			"核心重启",
			"重启请求发出后连接立即断开, 前端应保持可用 (错误被吞掉, 只提示已发送)。",
			[
				createButton("重启 Chirucat Core", async () => {
					toast(`核心重启请求已发送!`);
					log("apiFetch(\"/api/reboot_core\") ← 忽略错误, 因为 fetch 会立即失败");
					await apiFetch("/api/reboot_core").catch(() => void 0);
				}),
			]
		);

		refreshPanels();
	},
};
