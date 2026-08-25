import type { Message } from "../entity/message";

export type MessageFilterOption = {
	/** 黑白名单/速率限制作用对象: "session"(会话) 或 "sender"(用户), 默认 "session" */
	by?: "session" | "sender";
	/** 黑名单: 直接屏蔽的 id 集合 */
	blacklist?: Iterable<string>;
	/** 白名单: 非空时仅放行集合内的 id */
	whitelist?: Iterable<string>;
	/** 速率限制: windowMs 窗口内每个 id 最多 max 条消息 */
	rateLimit?: { windowMs: number; max: number };
}

type RateState = {
	count: number;
	resetAt: number;
}

export class MessageFilter {
	by: "session" | "sender";
	blacklist = new Set<string>();
	whitelist = new Set<string>();
	rateLimit: { windowMs: number; max: number } | null = null;

	private _rates = new Map<string, RateState>();

	constructor(option: MessageFilterOption = {}) {
		this.by = option.by ?? "session";
		if (option.blacklist) for (const id of option.blacklist) this.blacklist.add(id);
		if (option.whitelist) for (const id of option.whitelist) this.whitelist.add(id);
		if (option.rateLimit) this.rateLimit = option.rateLimit;
	}

	/**
	 * @param msg 
	 * @returns `true`为放行, `false`为阻止
	 */
	filter(msg: Message): boolean {
		const key = this.by === "sender" ? msg.sender.id : msg.session.id;

		// 黑名单优先
		if (this.blacklist.has(key)) return false;

		// 白名单非空时仅放行集合内
		if (this.whitelist.size > 0 && !this.whitelist.has(key)) return false;

		// 速率限制
		if (this.rateLimit && !this._allow(key)) return false;

		return true;
	}

	private _allow(key: string): boolean {
		const limit = this.rateLimit;
		if (!limit) return true;

		const now = Date.now();
		const state = this._rates.get(key);

		// 窗口过期, 重置
		if (!state || now >= state.resetAt) {
			this._rates.set(key, { count: 1, resetAt: now + limit.windowMs });
			return true;
		}

		state.count++;
		return state.count <= limit.max;
	}
}
