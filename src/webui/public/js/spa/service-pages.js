/**
 * 服务插件页面的前端对账器
 *
 * 一级导航 (活动栏) 与 Bot 详情窗口的二级导航都可以由服务插件在运行期注册。
 * 前端不做"事件流"那套增量同步, 而是**每次都拿权威清单来对账**:
 *
 * ```
 * GET /api/get_webui_pages  →  { version, pages: [{ key, scope, service, title, icon, module, styles, order, menu }] }
 * ```
 *
 * 对账是幂等的, 所以触发方式可以随便叠加, 任何一条路生效都不会导致不一致:
 *
 * - 启动时一次;
 * - 服务启停 / `refresh_services` 之后主动一次(那是导航变化的直接原因);
 * - 窗口重新获得焦点 / 标签页重新可见时一次;
 * - 兜底轮询 (默认 60s, 清单很小)。
 *
 * 版本号没变就直接返回, 因此这些触发加起来也只花一次请求。
 *
 * ## 为什么模块 URL 带 `?v=<版本>`
 *
 * ES 模块按 URL 永久缓存(在同一个文档的生命周期内), 停用再启用必须换一个地址才能
 * 拿到新代码 —— 服务端因此把 `module`/`icon`/`styles` 都拼成 `/service/<id>/public/...?v=<版本>`。
 * 注意: 这只能保证**入口模块**是新的, 它自己 import 的子模块仍是原 URL(见浏览器
 * 模块表), 所以改了插件的多个前端文件后要刷新一次页面 —— 与核心前端静态资源同性质。
 *
 * ## 停用即注销
 *
 * 服务停用 → 服务上下文的注销函数把页面从服务器清单里摘掉 → 版本号 +1 → 下一次对账
 * 发现"本地有、清单没有" → `app.unregister(id)`: 框架会调 `destroy()`、移除页面样式、
 * 并把用户带到别的页面(若正停在它上面, 这里再补一句提示)。
 */
import { callAPI } from "./api.js";
import toast from "./toast.js";

/** 插件没声明图标时的兜底图标 */
const FALLBACK_ICON = "/img/icons/cube.svg";

/** 兜底轮询周期(ms): 非浏览器发起的变更(手改配置/别的标签页)最迟这么久被发现 */
const DEFAULT_POLL_MS = 60_000;

/**
 * 影响前端页面定义的字段签名
 *
 * 只比"会不会让导航/页面变样"的字段: 变了就 update, 没变就什么都不做 —— 避免每次
 * 对账都重建导航按钮(那会打断悬停提示与高亮)。
 *
 * @param {object} view 服务端条目
 * @returns {string}
 */
function signature(view) {
	return JSON.stringify([
		view.title,
		view.icon ?? null,
		view.order,
		view.module,
		view.styles ?? [],
		(view.menu ?? []).map((item) => [item.key, item.title, item.module, item.styles ?? []]),
	]);
}

/**
 * import 一个插件前端模块, 返回它的默认导出(没有默认导出时用模块命名空间)
 * @param {string} url 绝对 URL (服务端已拼好并带上版本参数)
 */
async function importEntry(url) {
	const mod = await import(url);
	return mod?.default ?? mod;
}

/**
 * 渲染一个插件提供的前端入口
 *
 * 入口可以是函数 `(container, ...args) => void`, 也可以是带 `render` 的对象
 * (与页面模块同一形状, 便于插件复用同一个文件)。
 *
 * @param {string} url 模块 URL
 * @param {HTMLElement} container 渲染容器
 * @param {...unknown} args 额外参数 (如 SPA 应用对象 / 当前 Bot)
 */
async function renderEntry(url, container, ...args) {
	const entry = await importEntry(url);
	if (typeof entry === "function") {
		await entry(container, ...args);
		return;
	}
	if (entry && typeof entry.render === "function") {
		await entry.render(container, ...args);
		return;
	}
	container.textContent = "该插件模块没有导出可渲染的内容 (需要默认导出一个函数或 { render })";
}

/**
 * 由声明里的菜单骨架生成二级菜单项
 *
 * 菜单项的模块 URL 是服务端拼的(相对路径插件自己写不出来), 因此菜单只能由声明
 * 生成 —— 每个项的 `render` 在被点开时才 import 它的模块。
 *
 * @param {object} view 服务端条目
 */
function menuItems(view) {
	return (view.menu ?? []).map((item) => ({
		id: item.key,
		title: item.title,
		render: (container, app) => renderEntry(item.module, container, app),
	}));
}

/**
 * 由服务端条目生成前端的页面字段
 *
 * `styles` 与 `sidebar` 都走"挂到页面对象上"这条路: framework 进入页面时读的是
 * **页面模块**的 styles / sidebar, 而插件模块自己写不出绝对路径(相对路径会被解析
 * 到文档根), 所以由声明里给的、服务端拼好的数据补进去。
 *
 * 页面模块自己声明了 `sidebar` 时不覆盖它 —— 插件想在模块里(或用 `app.sidebar.*`
 * 运行期)自己管菜单, 就以它为准。
 *
 * @param {object} view 服务端条目
 */
function pageFields(view) {
	return {
		title: view.title,
		icon: view.icon ?? FALLBACK_ICON,
		async load() {
			const page = await importEntry(view.module);
			if (!Object.isExtensible(page)) return page;

			if (view.styles?.length) {
				page.styles = [...(page.styles ?? []), ...view.styles];
			}
			if (view.menu?.length && !(Array.isArray(page.sidebar) && page.sidebar.length > 0)) {
				page.sidebar = menuItems(view);
			}
			return page;
		},
	};
}

/** 生成一个完整的页面定义 (register 用) */
function pageDef(view) {
	return { id: view.key, ...pageFields(view) };
}

/**
 * 创建对账器
 *
 * @param {object} app SPA 应用对象
 * @param {object} [options]
 * @param {string | null} [options.insertBefore] 服务插件页面统一排在哪个核心页面之前(缺省追加到末尾)
 * @param {number} [options.pollMs] 兜底轮询周期, 0 表示不轮询
 */
export function createServicePageSync(app, { insertBefore = null, pollMs = DEFAULT_POLL_MS } = {}) {
	/** 已对过账的版本号 */
	let version = -1;
	/** 本地已注册的插件页面: 前端页面 id → 服务端条目 */
	const applied = new Map();
	/** 最近一次清单里的顺序 (服务端已按 order 排好) —— 重排时以它为准 */
	let orderedIds = [];
	/** 最近一次清单里的 Bot 作用域条目 */
	let botEntries = [];
	/** 变更订阅者 (Bot 详情窗口据此增删自己的二级菜单) */
	const listeners = new Set();

	let started = false;
	let timer = 0;
	/** 在途的一次对账: 重复触发共用它, 不并发拉清单 */
	let inFlight = null;

	/** 通知订阅者: 清单变了(已经对完账) */
	function notify() {
		for (const fn of [...listeners]) {
			try {
				fn();
			} catch (err) {
				console.error("[SPA] 服务插件页面订阅者出错:", err);
			}
		}
	}

	/**
	 * 服务插件页面该从哪个下标开始排
	 *
	 * 保持它们**连续**: 排在锚点页面之前(锚点不存在就排在末尾)。锚点由 app.js 指定,
	 * 这样"插件页面"在活动栏里的位置是核心前端的排版决定, 插件自己不用操心顺序之争。
	 *
	 * 关键点: 锚点页面**当前**的下标里已经包含先前插进去的服务页面, 拿它当目标会让
	 * 每次对账都把整块再往后挪一格(下一次又挪回来 —— 按钮就在锚点前后跳)。所以这里
	 * 数的是"锚点之前有多少个**非服务**页面", 那才是稳定目标: 对账用的下标一旦稳定,
	 * 重复对账就是幂等的。
	 *
	 * @param {string[]} ids 本次要排的服务插件页面 id
	 */
	function baseIndex(ids) {
		const pages = app.listPages();
		const mine = new Set(ids);
		const anchor = insertBefore ? pages.findIndex((page) => page.id === insertBefore) : -1;
		const scope = anchor >= 0 ? pages.slice(0, anchor) : pages;
		return scope.filter((page) => !mine.has(page.id)).length;
	}

	/**
	 * 按清单顺序重排本地已注册的插件页面
	 *
	 * 顺序取自**清单**(服务端已按 order 排好), 而不是本地"谁先注册谁在前" —— 否则
	 * 后来的页面即使 order 更小也只能排到末尾。
	 */
	function reorder() {
		const ids = orderedIds.filter((id) => applied.has(id));
		if (ids.length === 0) return;

		const base = baseIndex(ids);
		ids.forEach((id, offset) => {
			const current = app.listPages().findIndex((page) => page.id === id);
			const desired = base + offset;
			if (current >= 0 && current !== desired) app.update(id, { index: desired });
		});
	}

	/**
	 * 拉清单并对账
	 * @param {boolean} force 版本号没变也重新对账 (服务刚启停过时用)
	 */
	async function run(force) {
		let payload;
		try {
			payload = await callAPI("get_webui_pages", null, "GET");
		} catch (err) {
			// 服务未就绪 / 网络抖动: 保持现状, 等下一次触发 (轮询是兜底)
			console.warn("[SPA] 读取服务插件页面清单失败:", err?.message ?? err);
			return;
		}

		const next = Number(payload?.version ?? 0);
		if (!force && next === version) return;
		version = next;

		const views = Array.isArray(payload?.pages) ? payload.pages : [];
		botEntries = views.filter((view) => view.scope === "bot");

		// ---- 新增 / 更新 ----
		const wanted = new Map(views.filter((view) => view.scope !== "bot").map((view) => [view.key, view]));
		// 重排以清单顺序为准(服务端按 order 排好), 而不是本地"谁先注册谁在前"
		orderedIds = [...wanted.keys()];
		for (const [id, view] of wanted) {
			const prev = applied.get(id);
			if (!prev) {
				app.register(pageDef(view));
			} else if (signature(prev) !== signature(view)) {
				app.update(id, pageFields(view));
			}
			applied.set(id, view);
		}

		// ---- 删除: 服务停用 / 插件自己注销了页面 ----
		for (const [id, view] of [...applied]) {
			if (wanted.has(id)) continue;
			applied.delete(id);

			const wasOpen = app.sidebar.currentPageId() === id;
			app.unregister(id); // 框架负责 destroy + 移除样式 + 落到别的页面
			if (wasOpen) {
				toast(`「${view.title}」所属的服务已停用, 已离开该页面`, { type: "warn", duration: 5000 });
			}
		}

		reorder();
		notify();
	}

	/** 触发一次对账(不并发: 在途的一次直接复用) */
	function sync(force = false) {
		if (inFlight) return inFlight;
		inFlight = run(force).finally(() => { inFlight = null; });
		return inFlight;
	}

	/** 从后台切回来 / 窗口重新聚焦时顺手对一次账 */
	function onWake() {
		if (typeof document.visibilityState === "string" && document.visibilityState === "hidden") return;
		void api.sync();
	}

	const api = {
		/** 对账一次; force=true 时忽略版本号 */
		sync,
		/** 启动: 立即对一次账, 并挂上兜底轮询与"回到前台"触发 */
		start() {
			if (started) return;
			started = true;
			void sync();
			if (pollMs > 0) timer = setInterval(() => void sync(), pollMs);
			window.addEventListener("focus", onWake);
			document.addEventListener("visibilitychange", onWake);
		},
		/** 停止: 撤掉监听与定时器 (页面卸载/测试用) */
		stop() {
			if (!started) return;
			started = false;
			clearInterval(timer);
			timer = 0;
			window.removeEventListener("focus", onWake);
			document.removeEventListener("visibilitychange", onWake);
		},
		/**
		 * 订阅清单变化 (Bot 详情窗口据此增删二级菜单)
		 * @param {() => void} listener
		 * @returns {() => void} 退订
		 */
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** 当前清单里的 Bot 作用域条目 */
		botPages() {
			return botEntries.slice();
		},
		/** 当前离线的前端页面 id (调试/测试用) */
		appliedIds() {
			return [...applied.keys()];
		},
		/** 当前已对过账的版本号 (-1 = 还没对过) */
		get version() {
			return version;
		},
	};

	return api;
}

/** 全站唯一的对账器实例 (bot 窗口/服务管理页都从 getServicePages 取它) */
let current = null;

/**
 * 启动服务插件页面同步 (app.js 在 app.start() 之后调用)
 *
 * @param {object} app SPA 应用对象
 * @param {object} [options] 见 createServicePageSync
 * @returns {ReturnType<typeof createServicePageSync>}
 */
export function startServicePages(app, options = {}) {
	current?.stop();
	current = createServicePageSync(app, options);
	current.start();
	return current;
}

/** 取当前的对账器 (还没启动时为 null) */
export function getServicePages() {
	return current;
}

/**
 * 手动对一次账
 *
 * 服务插件页面/二级菜单的来源是服务本身, 因此"启停服务"和"刷新服务列表"之后
 * 主动调一次最直接(轮询是兜底, 不该让用户等一个周期)。
 *
 * @param {boolean} [force=true] 忽略版本号强制对账
 */
export function syncServicePages(force = true) {
	return current ? current.sync(force) : Promise.resolve();
}
