/**
 * WebUI 主题状态: 界面风格 × 明暗
 *
 * 两个正交的维度, 不要混为一谈:
 *
 *   界面风格 (style): "chirucat" | "vsc" | "md3" | "winui"
 *     服务端设置项, 来自设置页 WebUI 域的 frontConfig.uiStyle
 *     (见 src/config/settings/domains/webui.ts)。webui/config/get 下发,
 *     设置页保存后当场调 setUIStyle() 应用, 对所有访问者生效。
 *     默认档是 chirucat (本项目自己的风格); 认不出的值一律回落到它。
 *
 *   明暗 (mode): "auto" | "light" | "dark"
 *     每个浏览器自己的偏好, 顶栏按钮三态循环, 存 localStorage 的 "chirucat-theme"。
 *
 * 两者相乘得到 <html data-theme> 的取值, 由唯一的 themeAttr() 推导:
 *
 *                浅色            深色
 *     chirucat   chirucat        chirucat-dark → themes/chirucat.css (默认, 静态引入)
 *     vsc        vsc             vsc-dark      → themes/vsc.css
 *     md3        md3             md3-dark      → themes/md3.css
 *     winui      winui           winui-dark    → themes/winui.css
 *
 * 分工:
 *   - index.html 静态引入「默认皮肤 + 令牌接口」, 其 <head> 脚本按明暗写好首帧标记,
 *     保证默认档深色用户第一帧就是 chirucat-dark, 不闪 VSC; 非默认档由本模块在
 *     initTheme() 时切换 (设置页里的主动切换, 当场生效)。
 *   - 非默认皮肤在运行时按需注入 <link> (eager: false), 默认皮肤静态已引入 (eager: true),
 *     避免同一份表出现两个 <link>。注入是异步的, 所以先注入、再翻标记, 不留半成品帧。
 *   - syncUIStyleFromServer() 在登录后向服务端校准一次: 别的浏览器改了设置、
 *     或首次访问还没缓存时, 以服务端的值为准, 并写回本地缓存。
 */
import { callAPI } from "./api.js";

/** 明暗偏好 (沿用原有键, 老用户的偏好不丢) */
const THEME_KEY = "chirucat-theme";
/** 界面风格缓存: 接口回来前先用上次的值, 真值以服务端为准 */
const STYLE_KEY = "chirucat-ui-style";

/**
 * 皮肤注册表: 风格值 → 样式表 + 引入方式。
 * 这是风格值的唯一真相源 (键集合 == 合法的风格值集合)。
 *   eager: true  静态已在 index.html 引入, 运行时跳过注入 (默认皮肤)
 *   eager: false 运行时按需注入 <link>
 */
export const SKINS = {
	chirucat: { sheet: "/css/themes/chirucat.css", eager: true },
	vsc: { sheet: "/css/themes/vsc.css", eager: false },
	md3: { sheet: "/css/themes/md3.css", eager: false },
	winui: { sheet: "/css/themes/winui.css", eager: false },
};

/** 默认风格: 服务端没配 / 值认不出时用它 (与设置 schema 的 default 保持一致) */
export const DEFAULT_STYLE = "chirucat";

/** 认得的风格值 */
const SKIN_STYLES = Object.keys(SKINS);

/** 历史值别名 → 现行风格值 (值认不出时统一回落 DEFAULT_STYLE) */
const STYLE_ALIASES = {
	cyan: DEFAULT_STYLE, // 旧 Cyan Utility 视觉语言已更名为 chirucat
};

const MODES = ["auto", "light", "dark"];
const MODE_NAMES = { auto: "跟随系统", light: "浅色", dark: "深色" };

/**
 * 唯一的标记推导: style + 是否深色 → <html data-theme> 的值。
 * index.html 的 head 脚本内联了同一份语义 (那里只写默认皮肤首帧), 改动需两处同步,
 * 由 npm run check:webui-theme 的映射表断言兜底。
 */
export function themeAttr(style, dark) {
	return dark ? `${style}-dark` : style;
}

/** 把任意值规范化成合法风格值: 别名先转换, 认不出回落默认档 */
function normalizeStyle(value) {
	const key = STYLE_ALIASES[value] ?? value;
	return SKIN_STYLES.includes(key) ? key : DEFAULT_STYLE;
}

/** 当前界面风格; 首屏前由 <head> 脚本写过缓存, 这里读同一份 */
let style = DEFAULT_STYLE;
try {
	const cached = localStorage.getItem(STYLE_KEY);
	if (cached) style = normalizeStyle(cached);
} catch {
	/* localStorage 不可用 (隐私模式等): 按默认风格起步, 登录后由服务端校准 */
}

let mode = "auto";
/** 明暗按钮: 顶栏一只, 登录卡一只 (登录时顶栏被整块淡出) */
let themeToggles = [];
/** 已注入的非 eager 皮肤样式表 href 集合 (幂等) */
const injectedSheets = new Set();

/**
 * 预加载所有非 eager 皮肤样式表 (幂等)。
 *
 * 启动时一次性注入, 这样随后切换风格时样式已就位, 不会先翻 data-theme 再等
 * <link> 加载而露出「皮肤标记 + 兜底令牌」的半成品帧。eager: true 的默认皮肤
 * 静态已引入, 这里跳过, 避免同一份表出现两个 <link>。
 */
function ensureSkinStylesheets() {
	for (const [key, skin] of Object.entries(SKINS)) {
		if (skin.eager || injectedSheets.has(skin.sheet)) continue;
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = skin.sheet;
		document.head.append(link);
		injectedSheets.add(skin.sheet);
	}
}

function prefersDark() {
	return typeof matchMedia === "function"
		&& matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 提示当前明暗模式与下一次会切到什么 (两只按钮同步同一份文案) */
function syncLabel() {
	const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
	const label = `主题: ${MODE_NAMES[mode]} (点击切换到${MODE_NAMES[next]})`;
	for (const toggle of themeToggles) {
		toggle.title = label;
		toggle.setAttribute("aria-label", label);
	}
}

/** 把「风格 + 明暗」落到 <html> 的两个标记上 */
function apply() {
	document.documentElement.dataset.themeMode = mode;

	const dark = mode === "dark" || (mode === "auto" && prefersDark());
	document.documentElement.dataset.theme = themeAttr(style, dark);

	syncLabel();
}

/**
 * 应用界面风格 (设置页保存后、服务端配置校准时调用)
 *
 * @param {string} next 合法风格值之一; 别名按 STYLE_ALIASES 转换, 其他值一律回落默认档
 */
export function setUIStyle(next) {
	ensureSkinStylesheets(); // 兜底: 即便 initTheme 尚未执行也不会缺样式
	style = normalizeStyle(next);
	try {
		localStorage.setItem(STYLE_KEY, style);
	} catch {
		/* 写不进缓存不影响本次会话生效 */
	}
	apply();
}

/** 登录后向服务端校准界面风格; 失败时静默沿用本地缓存 */
export async function syncUIStyleFromServer() {
	try {
		const front = await callAPI("webui/config/get", null, "GET");
		setUIStyle(front?.uiStyle);
	} catch {
		/* 接口不可用 / 会话失效: 不阻塞界面, 风格保持缓存值 */
	}
}

/** 三态循环: 跟随系统 → 浅色 → 深色 → 跟随系统 */
function cycleMode() {
	mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
	apply();
	try {
		// 跟随系统也显式存下来, 这样用户能主动从手动模式切回跟随系统
		localStorage.setItem(THEME_KEY, mode);
	} catch {
		/* localStorage 不可用: 本次会话内仍生效, 只是记不住 */
	}
}

/** 接管顶栏与登录卡的明暗按钮、系统偏好变化; 由 app.js 启动时调用一次 */
export function initTheme() {
	ensureSkinStylesheets();
	themeToggles = [...document.querySelectorAll(".theme-toggle")];
	mode = MODES.includes(document.documentElement.dataset.themeMode)
		? document.documentElement.dataset.themeMode
		: "auto";

	for (const toggle of themeToggles) {
		toggle.addEventListener("click", cycleMode);
	}

	// 跟随系统时, 系统偏好变了要立刻反映到配色上 (两种风格都受影响)
	if (typeof matchMedia === "function") {
		const mq = matchMedia("(prefers-color-scheme: dark)");
		mq.addEventListener?.("change", () => { if (mode === "auto") apply(); });
	}

	apply();
}
