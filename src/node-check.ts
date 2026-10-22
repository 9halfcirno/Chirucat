import { VerChecker } from "./utils/ver-check";

export type VersionSpec = string | string[];
export type FixText = string | ((currentVersion: string) => string);
/** 一条方案, 或多条可并列选择的方案 */
export type FixList = FixText | FixText[];

export interface FixRule {
	minVersion: VersionSpec;
	/** 传数组时分条打印, 每条算一个独立方案 */
	fix: FixList;
}

export type FeatureLevel = "warn" | "error";

export interface FeatureRequirement {
	name: string;
	/** 多版本任一满足即可，如 ["22.12.0", "20.19.0"] */
	minVersion: VersionSpec;
	desc?: string;
	/**
	 * 不满足时的后果。
	 * - "warn"(缺省): 功能残缺, 框架仍可启动
	 * - "error": 框架 100% 起不来, 调用方据此退出
	 */
	level?: FeatureLevel;
	/** 不满足时的修复规则; 想自定义"无修复"文案, 用 { minVersion: "0.0.0", fix: "..." } 兜底 */
	fixes?: FixRule[];
	test?: (currentVersion: string) => boolean;
}

export type FeatureCheckResult =
	| {
		feature: FeatureRequirement;
		ok: true;
		currentVersion: string;
		level: FeatureLevel;
	}
	| {
		feature: FeatureRequirement;
		ok: false;
		currentVersion: string;
		level: FeatureLevel;
		/** 命中的修复方案; 多条并列时是数组; 未命中任何规则时为 "无可用修复方案" */
		fix: string | string[];
	};

/** 方便 buildWarning 里做类型守卫 */
type FailedResult = Extract<FeatureCheckResult, { ok: false }>;

const DEFAULT_NO_FIX = "无可用修复方案";

const toList = (spec: VersionSpec): string[] => (Array.isArray(spec) ? spec : [spec]);

/** 提取 major */
function getMajor(v: string): number {
	return Number.parseInt(v.replace(/^v/i, "").split(".")[0]!, 10) || 0;
}

/** 多版本优先匹配当前 major 线 */
function satisfies(current: string, spec: VersionSpec): boolean {
	const list = toList(spec);
	const currentMajor = getMajor(current);
	const sameMajor = list.filter((v) => getMajor(v) === currentMajor);

	// 当前 major 线在声明里有对应版本：只认这一条，避免 22.5.0 被 20.19.0 误判通过
	if (sameMajor.length > 0) {
		return sameMajor.some((v) => VerChecker.check(current, ">=", v));
	}
	// 当前 major 线不在声明里：退化为 >= 任一版本（兼容 23/25 这类奇数版本）
	return list.some((v) => VerChecker.check(current, ">=", v));
}

interface Recommendation {
	version: string;
	crossLine: boolean;
}

/** 优先当前 major 线内，否则跨 major */
function recommendVersion(current: string, failed: FeatureCheckResult[]): Recommendation {
	const currentMajor = getMajor(current);
	let needCross = false;
	let best: string | null = null;

	for (const r of failed) {
		const list = toList(r.feature.minVersion);
		const sameMajor = list.filter((v) => getMajor(v) === currentMajor);

		let pick: string;
		if (sameMajor.length > 0) {
			// 当前线内可满足：取该线内最低门槛
			pick = sameMajor.reduce((a, b) => (VerChecker.check(a, "<=", b) ? a : b));
		} else {
			// 当前线无法满足，必须跨 major：取该 feature 的最低可用版本
			needCross = true;
			pick = list.reduce((a, b) => (VerChecker.check(a, "<=", b) ? a : b));
		}

		if (best === null || VerChecker.check(pick, ">", best)) best = pick;
	}

	return { version: best ?? current, crossLine: needCross };
}

/** 用 check 做两两比较，取最高版本，不引入 compare */
function highestVersion(spec: VersionSpec): string {
	return toList(spec).reduce((max, v) =>
		VerChecker.check(v, ">=", max) ? v : max
	);
}

const resolveFixText = (fix: FixList, current: string): string | string[] =>
	Array.isArray(fix)
		? fix.map((one) => (typeof one === "function" ? one(current) : one))
		: typeof fix === "function" ? fix(current) : fix;

const withV = (v: string): string => (/^v/i.test(v) ? v : `v${v}`);

const levelOf = (feature: FeatureRequirement): FeatureLevel => feature.level ?? "warn";

export function checkFeature(current: string, feature: FeatureRequirement): FeatureCheckResult {
	const ok = feature.test ? feature.test(current) : satisfies(current, feature.minVersion);
	if (ok) return { feature, ok: true, currentVersion: current, level: levelOf(feature) };

	// 修复规则按适用最低版本从高到低匹配，第一条命中的生效
	// (比较器方向别写反: 反了会让 0.0.0 兜底规则先命中, 所有针对性文案都变成"无可用修复方案")
	const fixes = [...(feature.fixes ?? [])].sort((a, b) => {
		const aHigh = highestVersion(a.minVersion);
		const bHigh = highestVersion(b.minVersion);
		if (aHigh === bHigh) return 0;
		return VerChecker.check(aHigh, ">", bHigh) ? -1 : 1;
	});
	const matched = fixes.find((r) => satisfies(current, r.minVersion));

	return {
		feature,
		ok: false,
		currentVersion: current,
		level: levelOf(feature),
		fix: matched ? resolveFixText(matched.fix, current) : DEFAULT_NO_FIX,
	};
}

/** 极简 ANSI 序列，零依赖 */
const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
} as const;

type AnsiName = keyof typeof ANSI;

/** 遵循 NO_COLOR / FORCE_COLOR / TTY 约定 */
function detectColorSupport(): boolean {
	const env = process.env;
	if (env.NO_COLOR !== undefined) return false;      // 存在即禁用，值为空也算
	if (env.FORCE_COLOR !== undefined) {               // 优先于 TTY 检测
		const v = String(env.FORCE_COLOR).toLowerCase();
		return v !== "0" && v !== "false";
	}
	if (env.TERM === "dumb") return false;
	return Boolean(process.stdout?.isTTY || process.stderr?.isTTY);
}

/** 去掉 ANSI 序列，方便单测断言 */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface FeatureWarning {
	/** 排版好的提示块, 是否带 ANSI 由环境决定 */
	text: string;
	/** 存在 error 级(框架 100% 起不来)的未满足项, 调用方据此退出 */
	blocking: boolean;
}

const GROUP_HEAD: Record<FeatureLevel, string> = {
	error: "  以下问题会让框架无法启动:",
	warn: "  以下功能会有影响:",
};

export function buildWarning(
	current: string,
	features: FeatureRequirement[],
	options: { title?: string; recommend?: boolean; color?: boolean } = {}
): FeatureWarning | null {
	const failed = features
		.map((f) => checkFeature(current, f))
		.filter((r): r is FailedResult => !r.ok);	if (failed.length === 0) return null;

	const blocking = failed.some((r) => r.level === "error");

	// options.color 显式指定 > 环境自动检测
	const useColor = options.color ?? detectColorSupport();
	const paint = (text: string, ...names: AnsiName[]): string =>
		useColor ? names.map((n) => ANSI[n]).join("") + text + ANSI.reset : text;

	const rule = paint("============================", "dim");
	const lines = [
		rule,
		"",
		paint(
			options.title ?? `> ${blocking ? "Error" : "Warn"}: 当前 NodeJS 版本为 ${withV(current)}, 不满足框架运行要求\n> 列出问题与当前版本可能有用的修复方案`,
			"bold",
			blocking ? "red" : "yellow"
		),
		"",
	];

	// error 组先打印: 第一眼要看到"为什么起不来", 功能残缺是次要信息
	for (const group of (["error", "warn"] as const)) {
		const items = failed.filter((r) => r.level === group);
		if (items.length === 0) continue;

		const tone: AnsiName = group === "error" ? "red" : "yellow";
		lines.push(paint(GROUP_HEAD[group], tone));
		for (const r of items) {
			lines.push(paint(`    > ${r.feature.name}: ${r.feature.desc ?? r.feature.name}`, tone));
			const fixOptions = Array.isArray(r.fix) ? r.fix : [r.fix];
			if (fixOptions.length === 1) {
				lines.push(paint("      修复: ", "dim") + paint(String(fixOptions[0]), "cyan"));
			} else {
				lines.push(paint("      修复: ", "dim"));
				fixOptions.forEach((one, i) => {
					const label = `        方案 ${i + 1}: `;
					lines.push(paint(label, "dim") + paint(String(one), "cyan"));
				});
			}
		}
		lines.push("");
	}

	if (options.recommend !== false) {
		const { version: recommended, crossLine } = recommendVersion(current, failed);
		const currentMajor = getMajor(current);
		const recommendText = crossLine
			? `> 请升级为 Node ${withV(recommended)} 及以上以解决所有问题（当前 v${currentMajor} 大版本无法满足，需跨大版本升级）`
			: `> 请升级为 Node ${withV(recommended)} 及以上以解决所有问题（仅需在当前 v${currentMajor} 大版本内升级）`;
		lines.push("", paint(recommendText, crossLine ? "yellow" : "green"));
	}

	if (blocking) lines.push("", paint(`> ${failed.filter(i => i.level === "error").length} 个 Error 级别问题导致框架无法正常运行, 为保证稳定性已阻断启动`, "bold", "red"));

	lines.push("", rule);
	return { text: lines.join("\n"), blocking };
}