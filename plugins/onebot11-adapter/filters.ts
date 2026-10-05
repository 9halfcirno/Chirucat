import type Logger from "../../src/utils/logger";

/**
 * 内容过滤
 *
 * 规则来自用户配置(见 config.json 的 `filterRules`), 语义:
 * - 未启用过滤 -> 全部通过
 * - 启用但没有有效规则 -> 全部通过(空规则不等于"全部拦下")
 * - 启用且有有效规则 -> 命中任一规则即通过
 *
 * 正则缓存挂在实例上: 正则每次消息都重新编译代价不小, 非法正则也只需告警一次。
 * 缓存在适配器卸载时随实例一起释放。
 */

/** 一条过滤规则 */
export interface ContentFilterRule {
	/** 匹配方式: include / start / end / full / regex */
	type?: unknown;
	/** 匹配内容 */
	value?: unknown;
	/** 是否启用, 缺省视为启用 */
	enabled?: unknown;
	[key: string]: unknown;
}

export class ContentFilter {
	/** 正则文本 -> 编译结果(null 表示该文本非法) */
	private cache = new Map<string, RegExp | null>();

	constructor(private readonly logger: Logger) { }

	/**
	 * 判断消息文本是否通过过滤
	 * @param text 消息纯文本
	 * @param enabled 配置项 `contentFilter`
	 * @param rules 配置项 `filterRules`
	 */
	allows(text: string, enabled: unknown, rules: unknown): boolean {
		if (enabled !== true) return true;
		if (!Array.isArray(rules)) return true;

		let hasRule = false;
		for (const rule of rules as ContentFilterRule[]) {
			if (!rule || rule.enabled === false) continue;

			const value = String(rule.value ?? "");
			if (!value) continue;
			hasRule = true;

			if (this.match(text, rule.type, value)) return true;
		}

		return hasRule ? false : true;
	}

	/** 释放正则缓存 */
	clear(): void {
		this.cache.clear();
	}

	private match(text: string, type: unknown, value: string): boolean {
		switch (type) {
			case "include":
				return text.includes(value);
			case "start":
				return text.startsWith(value);
			case "end":
				return text.endsWith(value);
			case "full":
				return text === value;
			case "regex": {
				const regex = this.regex(value);
				if (!regex) return false;
				// 共享同一个 RegExp 实例, 带 g/y 标志时 lastIndex 会残留
				regex.lastIndex = 0;
				return regex.test(text);
			}
			default:
				return false;
		}
	}

	private regex(pattern: string): RegExp | null {
		const cached = this.cache.get(pattern);
		if (cached !== undefined) return cached;

		try {
			const regex = new RegExp(pattern);
			this.cache.set(pattern, regex);
			return regex;
		} catch (e) {
			this.logger.warn(`非法正则 "${pattern}": ${e instanceof Error ? e.message : String(e)}`);
			this.cache.set(pattern, null);
			return null;
		}
	}
}
