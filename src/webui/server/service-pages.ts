import { StateError } from "../../errors/state-error";

/**
 * 服务插件注册的 WebUI 页面
 *
 * 导航分两级, 注册也分两个作用域:
 * - `app`: 活动栏上的一级导航 (与核心页面平级)
 * - `bot`: Bot 详情窗口里的二级导航 (与"信息/插件/设置"平级)
 *
 * 插件给的都是**相对路径**, URL 由框架拼装 —— 这样可以像端点的命名空间那样,
 * 把 `..` 穿越、大小写冲突、跨插件抢占都在边界上挡住, 插件也不必知道自己的
 * id 会出现在哪个前缀下。
 */
export type ServicePageScope = "app" | "bot";

/**
 * 插件提交的二级菜单项
 *
 * 只传"骨架"(标题 + 模块): 菜单内容由那个模块渲染, 或者由页面模块自己在运行期
 * 用 `app.sidebar.*` 增删 —— 框架不替插件管菜单内容。
 */
export interface ServiceMenuItemDef {
	/** 菜单项 id (本页面内唯一); 缺省用 title */
	id?: string | undefined;
	/** 菜单项标题 */
	title: string;
	/** 相对插件 public/ 的 ES 模块路径, 选中该项时动态 import 它 */
	module: string;
	/** 该菜单项的样式表 (相对 public/), 首次渲染时插入 */
	styles?: string[] | undefined;
}

/** 插件提交的页面定义 */
export interface ServicePageDef {
	/**
	 * 页面 id: 单段(字母/数字/下划线/连字符), 在本插件内唯一
	 *
	 * 前端实际使用的页面 id 由框架拼成 `svc-<插件id>-<页面id>` —— 带 `:` 之类的
	 * 字符不能进 hash 路由(见 framework.js 的 parseHash), 所以这里只收单段。
	 */
	id: string;
	/** 页面标题 (导航按钮的可访问名与提示) */
	title: string;
	/** 相对插件 public/ 的 ES 模块路径 (页面入口) */
	module: string;
	/** 图标, 相对插件 public/ 的路径 */
	icon?: string | undefined;
	/** 页面样式表 (相对 public/), 进入页面时加载, 离开时移除 */
	styles?: string[] | undefined;
	/** 排序权重, 越小越靠前; 缺省 100 */
	order?: number | undefined;
	/** 二级菜单 (仅 app 作用域用; bot 作用域忽略) */
	menu?: ServiceMenuItemDef[] | undefined;
}

/** 二级菜单项 (已拼装 URL, 发往前端的形状) */
export interface ServiceMenuItemView {
	/** 前端用于匹配"还是那一条菜单"的稳定 id */
	key: string;
	title: string;
	module: string;
	styles: string[];
}

/** 发往前端的页面条目 */
export interface ServicePageView {
	/** 前端实际使用的页面 id (app 作用域下必须是合法的 hash 段) */
	key: string;
	scope: ServicePageScope;
	/** 归属的服务插件 id */
	service: string;
	title: string;
	/** 已拼好的图标 URL; 未声明时为 null */
	icon: string | null;
	/** 已拼好的模块 URL (带 ?v=<版本>, 见下方说明) */
	module: string;
	styles: string[];
	order: number;
	menu: ServiceMenuItemView[];
}

/** 一条已注册的页面 */
interface PageEntry {
	owner: string;
	scope: ServicePageScope;
	def: ServicePageDef;
	/** 注册序号: 同 order 时保持"谁先注册谁在前" */
	seq: number;
}

/** 单段 id: 页面 id / 菜单 id / 服务插件 id (与 serviceSegment 同一口径) */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * 相对 public 的资源路径
 *
 * 首字符必须是字母/数字/下划线 —— 顺带拒绝绝对路径与 `./` 开头; 允许中间的分隔符
 * 以便插件把前端资源放进子目录。`..` 由 assertAsset 逐段检查。
 */
const ASSET = /^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/;

/** 页面 order 的默认值 */
const DEFAULT_ORDER = 100;

/** 校验一个相对 public 的资源路径 (模块 / 图标 / 样式表共用) */
function assertAsset(owner: string, what: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new StateError(`服务插件 ${owner} 的页面${what}必须是非空字符串`);
	}
	if (!ASSET.test(value) || value.split("/").some((seg) => seg === "." || seg === "..")) {
		throw new StateError(
			`服务插件 ${owner} 的页面${what}必须是相对 public/ 的路径(不能以 / 开头, 不能含 ..): ${JSON.stringify(value)}`,
		);
	}
	return value;
}

/** 校验单段 id */
function assertSegment(owner: string, what: string, value: unknown): string {
	if (typeof value !== "string" || !SEGMENT.test(value)) {
		throw new StateError(
			`服务插件 ${owner} 的页面${what}必须是单段(字母/数字/下划线/连字符): ${JSON.stringify(value)}`,
		);
	}
	return value;
}

/** 校验字符串数组 (样式表列表) */
function assertStyles(owner: string, what: string, value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new StateError(`服务插件 ${owner} 的页面${what}必须是数组`);
	return value.map((item) => assertAsset(owner, what, item));
}

/**
 * 校验并规范化一份页面定义
 *
 * 校验失败抛 StateError: 这类错误都是插件代码写错了, 早失败早暴露, 而不是渲染出
 * 一个点不开的导航项。
 */
function normalizeDef(owner: string, scope: ServicePageScope, def: ServicePageDef): ServicePageDef {
	if (!def || typeof def !== "object") {
		throw new StateError(`服务插件 ${owner} 注册页面失败: 定义必须是对象`);
	}
	const id = assertSegment(owner, "id", def.id);
	if (typeof def.title !== "string" || def.title.length === 0) {
		throw new StateError(`服务插件 ${owner} 的页面 ${id} 缺少 title`);
	}
	const module = assertAsset(owner, "module", def.module);
	const icon = def.icon === undefined ? undefined : assertAsset(owner, "icon", def.icon);
	const styles = assertStyles(owner, ` ${id} 的 styles`, def.styles);

	let order = def.order;
	if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) {
		throw new StateError(`服务插件 ${owner} 的页面 ${id} 的 order 必须是数字`);
	}
	order ??= DEFAULT_ORDER;

	const menu: ServiceMenuItemDef[] = [];
	for (const raw of def.menu ?? []) {
		if (!raw || typeof raw !== "object") {
			throw new StateError(`服务插件 ${owner} 的页面 ${id} 的 menu 项必须是对象`);
		}
		if (typeof raw.title !== "string" || raw.title.length === 0) {
			throw new StateError(`服务插件 ${owner} 的页面 ${id} 的 menu 项缺少 title`);
		}
		const itemId = raw.id === undefined ? raw.title : assertSegment(owner, ` ${id} 的菜单 id`, raw.id);
		menu.push({
			id: itemId,
			title: raw.title,
			module: assertAsset(owner, ` ${id} 的菜单 module`, raw.module),
			styles: assertStyles(owner, ` ${id} 的菜单 styles`, raw.styles),
		});
	}

	return { id, title: def.title, module, icon, styles, order, menu };
}

/**
 * 服务插件页面注册表
 *
 * 只负责"记账 + 拼 URL + 记版本号", 不碰 HTTP、不碰 DOM:
 * - 端点/静态资源那套活跃性标记在这里不需要 —— 页面只在服务启用期间注册,
 *   服务上下文释放时注销函数会被框架调用(见 ServiceContext.dispose), 因此表里
 *   留下的天然都是"当前活着"的页面;
 * - `version` 每次增删都 +1, 前端据此判断"清单变了没有", 它同时充当模块 URL 的
 *   缓存参数: ES 模块按 URL 永久缓存, 停用再启用必须换一个 URL。
 */
export class ServicePageRegistry {
	/** 键为 `scope\u0000前端页面 id`, 值为条目 */
	private readonly pages = new Map<string, PageEntry>();
	private seq = 0;
	private rev = 0;

	/** 清单版本号: 增删各 +1 */
	get version(): number {
		return this.rev;
	}

	/**
	 * 注册一个页面
	 *
	 * 同一个 (插件, 作用域, 页面 id) 重复注册只换条目(服务停用后重新启用是正常路径);
	 * 返回的注销函数带归属校验, 旧注销不会影响重新注册后的新条目。
	 *
	 * @param owner 服务插件 id
	 * @param segment 插件在 `/service` 下的路径段 (由 WebUIServer 校验并分配)
	 * @param scope 作用域
	 * @param def 页面定义 (相对路径)
	 * @returns 注销函数
	 */
	register(owner: string, segment: string, scope: ServicePageScope, def: ServicePageDef): () => void {
		const normalized = normalizeDef(owner, scope, def);

		// 前端 id: app 作用域要能进 hash 路由, 所以只由字母/数字/下划线/连字符组成
		const key = scope === "app" ? `svc-${owner}-${normalized.id}` : `${owner}-${normalized.id}`;
		const mapKey = `${scope}\u0000${key}`;

		const existing = this.pages.get(mapKey);
		// 不同插件/页面拼出同一个前端 id 时立刻报错: 否则后注册的会静默顶掉前一个
		if (existing && (existing.owner !== owner || existing.def.id !== normalized.id)) {
			throw new StateError(
				`服务插件 ${owner} 的页面 ${normalized.id} 与 ${existing.owner} 的页面 ${existing.def.id} ` +
				`撞了同一个前端 id (${key}), 请改名`,
			);
		}

		const entry: PageEntry = { owner, scope, def: normalized, seq: ++this.seq };
		this.pages.set(mapKey, entry);
		this.rev++;

		return () => {
			// 只注销本次注册的条目: 重新注册后 map 里已经是新对象
			if (this.pages.get(mapKey) === entry) {
				this.pages.delete(mapKey);
				this.rev++;
			}
		};
	}

	/** 当前页面清单 (已拼装 URL, 按 order 升序, 同 order 按注册顺序) */
	list(): ServicePageView[] {
		const version = this.rev;
		return [...this.pages.values()]
			.sort((a, b) => (a.def.order ?? DEFAULT_ORDER) - (b.def.order ?? DEFAULT_ORDER) || a.seq - b.seq)
			.map((entry) => this.toView(entry, version));
	}

	/** 条目的前端 key (与 register 里的算法保持一致) */
	private entryKey(entry: PageEntry): string {
		return entry.scope === "app" ? `svc-${entry.owner}-${entry.def.id}` : `${entry.owner}-${entry.def.id}`;
	}

	/** 拼装发往前端的条目: 资源路径一律落在该插件自己的 `/service/<id>/public` 下 */
	private toView(entry: PageEntry, version: number): ServicePageView {
		const base = `/service/${entry.owner}/public`;
		const withVersion = (relative: string) => `${base}/${relative}?v=${version}`;

		return {
			key: this.entryKey(entry),
			scope: entry.scope,
			service: entry.owner,
			title: entry.def.title,
			icon: entry.def.icon ? withVersion(entry.def.icon) : null,
			module: withVersion(entry.def.module),
			styles: (entry.def.styles ?? []).map(withVersion),
			order: entry.def.order ?? DEFAULT_ORDER,
			menu: entry.scope === "app"
				? (entry.def.menu ?? []).map((item) => ({
					key: `${entry.def.id}:${item.id ?? item.title}`,
					title: item.title,
					module: withVersion(item.module),
					styles: (item.styles ?? []).map(withVersion),
				}))
				: [],
		};
	}
}
