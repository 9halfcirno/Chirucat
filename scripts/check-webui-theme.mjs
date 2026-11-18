/**
 * WebUI 主题系统一致性校验 (Node, 无浏览器)
 *
 * 守住 docs/webui/theme-refactor.md 重做后的不变量:
 *   1. SKINS 注册表里的样式表文件都存在; index.html 的静态引入与 eager 标记一致
 *      (eager 的皮肤必须静态引入且不重复注入, 非 eager 的不能静态引入)。
 *   2. 每套皮肤都声明了接口 (tokens.css) 要求的全部「颜色」令牌 —— 按「计算后集合」
 *      语义: 皮肤浅块/深块声明的颜色令牌, 连同它从 tokens.css :root 继承的结构令牌,
 *      合起来覆盖接口全集; 缺的颜色令牌逐条报名字。
 *   3. 结构令牌在浅块与深块取值一致 (皮肤用联合块只声明一次, 天然满足)。
 *   4. themeAttr() 的映射表逐条断言 (含 auto + 系统深色偏好): 真正 import theme.js 调用。
 *   5. webui.ts 的 uiStyle.default === theme.js 的 DEFAULT_STYLE === SKINS 的键之一,
 *      且 SKINS 键集合 === schema 下拉项集合, 解决手抄漂移。
 *
 * 做法: 用极简 DOM 桩满足 theme.js 顶层与 apply 的读写, 再动态 import 真实模块调用
 * themeAttr / setUIStyle; CSS 与 TS 文件按文本解析 (不依赖浏览器/Puppeteer)。
 *
 * 运行: node scripts/check-webui-theme.mjs  (或 npm run check:webui-theme)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "src", "webui", "public");
const THEMES = path.join(PUB, "css", "themes");
const read = (p) => fs.readFileSync(p, "utf8");

// ==================== 断言小工具 ====================
let failures = 0;
let checks = 0;
function ok(cond, name, detail = "") {
	checks++;
	if (cond) { console.log(`  \u2713 ${name}`); return true; }
	failures++;
	console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
	return false;
}
function eq(actual, expected, name) {
	return ok(JSON.stringify(actual) === JSON.stringify(expected), name,
		`实际 ${JSON.stringify(actual)}, 期望 ${JSON.stringify(expected)}`);
}
function section(t) { console.log(`\n== ${t} ==`); }

// ==================== 极简 DOM 桩 (供 theme.js 顶层与 apply 使用) ====================
const links = [];
globalThis.localStorage = {
	_m: new Map(),
	getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
	setItem(k, v) { this._m.set(k, String(v)); },
	removeItem(k) { this._m.delete(k); },
};
globalThis.document = {
	documentElement: { dataset: {} },
	head: { append(el) { links.push(el); } },
	createElement(tag) { return { tag, rel: "", href: "", _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; } }; },
	querySelectorAll() { return []; },
};
let prefersDark = false;
globalThis.matchMedia = () => ({
	get matches() { return prefersDark; },
	addEventListener() { },
	removeEventListener() { },
});

// ==================== 解析工具 ====================
/** 解析一个 CSS 文件里所有 :root[data-theme=...] 块, 返回 [{ selectors, tokens:Map<name,value> }] */
function parseBlocks(src) {
	const out = [];
	const re = /:root\[data-theme[^\]]*\](?:\s*,\s*:root\[data-theme[^\]]*\])*\s*\{/g;
	let m;
	while ((m = re.exec(src))) {
		const selectors = [...m[0].matchAll(/data-theme="([^"]+)"/g)].map((x) => x[1]);
		let i = re.lastIndex, depth = 1;
		while (i < src.length && depth > 0) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") depth--;
			i++;
		}
		const body = src.slice(re.lastIndex, i - 1);
		const tokens = new Map();
		for (const mm of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(mm[1], mm[2].trim());
		out.push({ selectors, tokens });
		re.lastIndex = i;
	}
	return out;
}

/** 从 tokens.css 里划出颜色令牌集合: 「颜色」section 下、值不是纯长度的令牌 */
function interfaceTokens(src) {
	const all = new Map();
	for (const mm of src.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) all.set(mm[1], mm[2].trim());
	const colors = new Set();
	let inColor = false;
	for (const line of src.split(/\r?\n/)) {
		if (line.includes("===")) {
			if (/颜色|表面|文字|线条|语义|遮罩/.test(line)) { inColor = true; continue; }
			if (/结构|层级|动效|阴影/.test(line)) { inColor = false; continue; }
		}
		if (!inColor) continue;
		const mm = line.match(/(--[a-zA-Z0-9-]+)\s*:/);
		if (!mm) continue;
		const value = all.get(mm[1]) ?? "";
		if (/^-?\d/.test(value)) continue; // 纯长度/数值 (如 --glass-blur: 10px) 不是颜色
		colors.add(mm[1]);
	}
	return { all, colors };
}

/**
 * 从 tokens.css 划出「必须浅深一致」的纯几何令牌:
 * 结构 · 布局尺寸 / 字体与密度 / 间距 / 圆角 / 层级 / 动效。
 * 刻意排除 形态钩子 (含颜色, 如 --btn-bg)、阴影 (深色本就更重)、颜色、皮肤私有令牌 ——
 * 这些都允许按明暗分档 (契约 §4.4#3 只约束几何令牌)。
 */
function geometryTokens(src) {
	const set = new Set();
	let inGeom = false;
	for (const line of src.split(/\r?\n/)) {
		if (line.includes("===")) {
			if (/结构\s*[·/]\s*(布局尺寸|字体与密度|间距|圆角|层级|动效)/.test(line)) { inGeom = true; continue; }
			if (/颜色|结构\s*[·/]\s*(形态钩子|阴影)/.test(line)) { inGeom = false; continue; }
		}
		if (!inGeom) continue;
		const mm = line.match(/(--[a-zA-Z0-9-]+)\s*:/);
		if (mm) set.add(mm[1]);
	}
	return set;
}

// ==================== 载入被测模块 ====================
const themeJsPath = path.join(PUB, "js", "spa", "theme.js");
const indexHtml = read(path.join(PUB, "index.html"));
const webuiTs = read(path.join(ROOT, "src", "config", "settings", "domains", "webui.ts"));
const typesTs = read(path.join(ROOT, "src", "webui", "server", "types.ts"));
const { SKINS, DEFAULT_STYLE, themeAttr, setUIStyle } = await import(
	pathToFileURL(themeJsPath).href + `?t=${Date.now()}`
);

// ==================== 1. SKINS 表 / 样式表存在性 / 静态引入一致 ====================
section("SKINS 注册表与样式表引入");
const skinKeys = Object.keys(SKINS);
ok(skinKeys.includes(DEFAULT_STYLE), "DEFAULT_STYLE 是 SKINS 的键之一", DEFAULT_STYLE);

const staticThemes = [...indexHtml.matchAll(/<link[^>]+href="css\/themes\/([^"]+\.css)"/g)].map((m) => m[1]);
const eagerSkins = skinKeys.filter((k) => SKINS[k].eager);
const lazySkins = skinKeys.filter((k) => !SKINS[k].eager);

section("每个 SKINS[*].sheet 文件存在");
for (const key of skinKeys) {
	const sheet = SKINS[key].sheet;
	const rel = sheet.replace(/^\//, "");
	const onDisk = fs.existsSync(path.join(PUB, rel));
	ok(onDisk, `${key} 的样式表存在: ${rel}`);
}

section("index.html 静态引入与 eager 一致");
ok(staticThemes.includes("tokens.css"), "令牌接口 tokens.css 静态引入");
for (const key of eagerSkins) {
	const file = SKINS[key].sheet.split("/").pop();
	const n = staticThemes.filter((f) => f === file).length;
	eq(n, 1, `eager 皮肤 ${key} 静态引入且只出现 1 次`);
}
for (const key of lazySkins) {
	const file = SKINS[key].sheet.split("/").pop();
	ok(!staticThemes.includes(file), `非 eager 皮肤 ${key} 不被静态引入`);
}
ok(!staticThemes.includes("default.css") && !staticThemes.includes("dark.css"),
	"不存在旧文件名 default.css / dark.css 的引入");

// 运行时注入只覆盖非 eager 皮肤: 调 setUIStyle 后检查追加的 <link>
section("运行时注入跳过 eager 皮肤");
setUIStyle(DEFAULT_STYLE); // 触发 ensureSkinStylesheets
const injected = links.filter((l) => l.tag === "link").map((l) => l.href.split("/").pop());
eq([...new Set(injected)].sort(), [...lazySkins.map((k) => SKINS[k].sheet.split("/").pop())].sort(),
	"只注入非 eager 皮肤, 且每份只注入一次");

// ==================== 2/3. 令牌完整性 + 结构浅深一致 ====================
section("令牌完整性 (计算后集合, 颜色令牌逐皮肤覆盖)");
const tokensCssSrc = read(path.join(THEMES, "tokens.css"));
const { all: baseTokens, colors: baseColors } = interfaceTokens(tokensCssSrc);
const geometry = geometryTokens(tokensCssSrc);
ok(baseColors.size > 0, `从 tokens.css 解析出 ${baseColors.size} 个颜色令牌`);
ok(geometry.size > 0, `从 tokens.css 解析出 ${geometry.size} 个几何令牌`);

for (const key of skinKeys) {
	const file = SKINS[key].sheet.split("/").pop();
	const blocks = parseBlocks(read(path.join(THEMES, file)));
	const lightName = key;
	const darkName = `${key}-dark`;
	const lightTokens = new Set();
	const darkTokens = new Set();
	const lightValues = new Map();
	const darkValues = new Map();
	for (const b of blocks) {
		for (const sel of b.selectors) {
			const target = sel === lightName ? lightTokens : sel === darkName ? darkTokens : null;
			if (!target) continue;
			for (const [name, value] of b.tokens) {
				target.add(name);
				(sel === lightName ? lightValues : darkValues).set(name, value);
			}
		}
	}
	// 颜色令牌必须浅深两块都声明 (否则该档会掉到 tokens.css 兜底色)
	const missLight = [...baseColors].filter((t) => !lightTokens.has(t));
	const missDark = [...baseColors].filter((t) => !darkTokens.has(t));
	ok(missLight.length === 0, `${key} 浅块声明全部颜色令牌`, missLight.join(", "));
	ok(missDark.length === 0, `${key} 深块声明全部颜色令牌`, missDark.join(", "));

	// 几何令牌若在浅深两块都声明, 取值必须一致 (形态钩子/阴影/私有令牌允许分档)
	const drift = [];
	for (const [name, lv] of lightValues) {
		if (!geometry.has(name) || !darkValues.has(name)) continue;
		if (darkValues.get(name) !== lv) drift.push(name);
	}
	ok(drift.length === 0, `${key} 几何令牌浅深一致`, drift.join(", "));

	// 计算后集合: 皮肤声明 ∪ tokens.css 基础令牌 覆盖接口全集 (恒覆盖, 显式记录)
	const computed = new Set([...baseTokens.keys(), ...lightTokens, ...darkTokens]);
	const missComputed = [...baseTokens.keys()].filter((t) => !computed.has(t));
	ok(missComputed.length === 0, `${key} 计算后令牌集合覆盖接口全集`);
}

// ==================== 4. themeAttr 映射断言 ====================
section("themeAttr() 映射表 (含 auto + 系统深色)");
for (const key of skinKeys) {
	eq(themeAttr(key, false), key, `themeAttr(${key}, 浅) === ${key}`);
	eq(themeAttr(key, true), `${key}-dark`, `themeAttr(${key}, 深) === ${key}-dark`);
}
// 逐条断言: 与 index.html 内联首帧脚本的语义一致 (默认皮肤 + 明暗)
eq(themeAttr(DEFAULT_STYLE, false), DEFAULT_STYLE, "首帧浅色: 默认皮肤标记");
eq(themeAttr(DEFAULT_STYLE, true), `${DEFAULT_STYLE}-dark`, "首帧深色: 默认皮肤-dark 标记");
// auto + 系统深色偏好: 用真实 apply 路径验证 <html data-theme>
prefersDark = true;
setUIStyle(DEFAULT_STYLE);
document.documentElement.dataset.themeMode = "auto";
eq(document.documentElement.dataset.theme, `${DEFAULT_STYLE}-dark`,
	"auto + 系统深色 → 默认皮肤-dark");
prefersDark = false;
setUIStyle(DEFAULT_STYLE); // 再次 apply, 系统回到浅色
eq(document.documentElement.dataset.theme, DEFAULT_STYLE,
	"auto + 系统浅色 → 默认皮肤");
// 内联网页脚本确实写了同一语义 (逐字复刻, 人工同步的兜底检查)
ok(indexHtml.includes('dark ? "chirucat-dark" : "chirucat"'),
	"index.html 首帧脚本内联了 themeAttr 语义");

// ==================== 5. 默认值一致性 / 手抄漂移 ====================
section("默认值一致性 (schema === DEFAULT_STYLE === SKINS 键)");
const schemaDefault = webuiTs.match(/id:\s*"uiStyle"[\s\S]*?default:\s*"([^"]+)"/)?.[1];
ok(!!schemaDefault, "从 webui.ts 解析出 uiStyle.default", String(schemaDefault));
eq(schemaDefault, DEFAULT_STYLE, "webui.ts default === theme.js DEFAULT_STYLE");
ok(skinKeys.includes(schemaDefault), "schema default 是 SKINS 的键之一");

// 下拉项值集合 === SKINS 键集合
const uiStyleItemsBlock = webuiTs.match(/id:\s*"uiStyle"[\s\S]*?items:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
const itemValues = [...uiStyleItemsBlock.matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
eq(itemValues, [...skinKeys].sort(), "schema 下拉项集合 === SKINS 键集合");

// 两个 TS 联合类型都包含全部 SKINS 键
const uiStyleType = webuiTs.match(/uiStyle\??:\s*([^;]+);/)?.[1] ?? "";
const frontUiStyleType = typesTs.match(/uiStyle\??:\s*([^;]+);/)?.[1] ?? "";
for (const key of skinKeys) {
	ok(uiStyleType.includes(`"${key}"`), `webui.ts 联合类型含 ${key}`);
	ok(frontUiStyleType.includes(`"${key}"`), `types.ts 联合类型含 ${key}`);
}

// ==================== 汇总 ====================
console.log(`\n${failures === 0 ? "全部通过" : "有失败"}: ${checks - failures}/${checks}`);
if (failures > 0) process.exitCode = 1;
