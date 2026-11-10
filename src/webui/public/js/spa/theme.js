/**
 * WebUI 主题状态: 界面风格 × 明暗
 *
 * 两个正交的维度, 不要混为一谈:
 *
 *   界面风格 (style): "vsc" | "md3" | "winui"
 *     服务端设置项, 来自设置页 WebUI 域的 frontConfig.uiStyle
 *     (见 src/config/settings/domains/webui.ts)。get_webui_front_config 下发,
 *     设置页保存后当场调 setUIStyle() 应用, 对所有访问者生效。
 *
 *   明暗 (mode): "auto" | "light" | "dark"
 *     每个浏览器自己的偏好, 顶栏按钮三态循环, 存 localStorage 的 "chirucat-theme"。
 *
 * 两者相乘得到 <html data-theme> 的取值:
 *
 *                浅色          深色
 *     vsc        (不设置)      dark        → themes/default.css / dark.css
 *     md3        md3           md3-dark    → themes/md3.css
 *     winui      winui         winui-dark  → themes/winui.css
 *
 * 分工:
 *   - index.html 保持原样, 完全不感知「界面风格」; 它的 <head> 脚本只管明暗,
 *     皮肤样式表也不在页面里静态引入 —— 本模块在运行时注入 <link> 预加载,
 *     保证切换风格时样式已就位, 不出现「皮肤标记 + VSC 令牌」的半成品帧。
 *   - initTheme() 接管顶栏明暗交互与系统偏好变化。
 *   - syncUIStyleFromServer() 在登录后向服务端校准一次: 别的浏览器改了设置、
 *     或首次访问还没缓存时, 以服务端的值为准, 并写回本地缓存。
 */
import { callAPI } from "./api.js";

/** 明暗偏好 (沿用原有键, 老用户的偏好不丢) */
const THEME_KEY = "chirucat-theme";
/** 界面风格缓存: 接口回来前先用上次的值, 真值以服务端为准 */
const STYLE_KEY = "chirucat-ui-style";
/** 皮肤样式表: 启动时全部预加载; 未压缩各约 10KB, 内部管理后台可忽略 */
const SKIN_STYLESHEETS = {
	md3: "/css/themes/md3.css",
	winui: "/css/themes/winui.css",
};

/** 认得的风格值 (服务端/缓存里出现其他值一律回落 vsc) */
const SKIN_STYLES = Object.keys(SKIN_STYLESHEETS);

const MODES = ["auto", "light", "dark"];
const MODE_NAMES = { auto: "跟随系统", light: "浅色", dark: "深色" };

/** 当前界面风格; 首屏前由 <head> 脚本写过缓存, 这里读同一份 */
let style = "vsc";
try {
	const cached = localStorage.getItem(STYLE_KEY);
	if (SKIN_STYLES.includes(cached)) style = cached;
} catch {
	/* localStorage 不可用 (隐私模式等): 按 vsc 起步, 登录后由服务端校准 */
}

let mode = "auto";
let themeToggle = null;
let cssInjected = false;

/**
 * 幂等地预加载全部皮肤样式表。
 *
 * 无条件预加载而不是「等选中某皮肤再加载」: 动态 <link> 是异步的, 若先翻
 * data-theme 再等样式到位, 中间会有一帧 VSC 令牌配皮肤标记的半成品界面。
 */
function ensureSkinStylesheets() {
	if (cssInjected) return;
	cssInjected = true;
	for (const href of Object.values(SKIN_STYLESHEETS)) {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		document.head.append(link);
	}
}

function prefersDark() {
	return typeof matchMedia === "function"
		&& matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 提示当前明暗模式与下一次会切到什么 */
function syncLabel() {
	if (!themeToggle) return;
	const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
	const label = `主题: ${MODE_NAMES[mode]} (点击切换到${MODE_NAMES[next]})`;
	themeToggle.title = label;
	themeToggle.setAttribute("aria-label", label);
}

/** 把「风格 + 明暗」落到 <html> 的两个标记上 */
function apply() {
	document.documentElement.dataset.themeMode = mode;

	const dark = mode === "dark" || (mode === "auto" && prefersDark());
	let theme = "";
	if (style !== "vsc") theme = dark ? `${style}-dark` : style;
	else if (dark) theme = "dark";

	// VSC 浅色刻意不设 data-theme: default.css 的 :root 就是浅色基准
	if (theme) document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;

	syncLabel();
}

/**
 * 应用界面风格 (设置页保存后、服务端配置校准时调用)
 *
 * @param {string} next "vsc" | "md3" | "winui"; 其他值一律按 "vsc" 处理
 */
export function setUIStyle(next) {
	ensureSkinStylesheets(); // 兜底: 即便 initTheme 尚未执行也不会缺样式
	style = SKIN_STYLES.includes(next) ? next : "vsc";
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
		const front = await callAPI("get_webui_front_config", null, "GET");
		setUIStyle(front?.uiStyle);
	} catch {
		/* 接口不可用 / 会话失效: 不阻塞界面, 风格保持缓存值 */
	}
}

/** 接管顶栏明暗按钮与系统偏好变化; 由 app.js 启动时调用一次 */
export function initTheme() {
	ensureSkinStylesheets();
	themeToggle = document.getElementById("theme-toggle");
	mode = MODES.includes(document.documentElement.dataset.themeMode)
		? document.documentElement.dataset.themeMode
		: "auto";

	if (themeToggle) {
		themeToggle.addEventListener("click", () => {
			mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
			apply();
			try {
				// 跟随系统也显式存下来, 这样用户能主动从手动模式切回跟随系统
				localStorage.setItem(THEME_KEY, mode);
			} catch {
				/* localStorage 不可用: 本次会话内仍生效, 只是记不住 */
			}
		});
	}

	// 跟随系统时, 系统偏好变了要立刻反映到配色上 (两种风格都受影响)
	if (typeof matchMedia === "function") {
		const mq = matchMedia("(prefers-color-scheme: dark)");
		mq.addEventListener?.("change", () => { if (mode === "auto") apply(); });
	}

	apply();
}
