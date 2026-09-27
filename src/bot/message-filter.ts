import type { Message } from "../entity/message";
import type { FilterSets, LayerSets } from "../internal/filter-list";

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

/**
 * 一层名单
 *
 * 同一层里, 用户名单与会话名单各自独立判定, 两者都放行才算通过。
 * 会话名单用于群 / 频道; 私聊会话与用户一一对应, 由用户名单覆盖即可。
 */
export class FilterLayer {
	/** 按发送者账号判定 */
	readonly users = new MessageFilter({ by: "sender" });
	/** 按会话判定 (群 / 频道) */
	readonly sessions = new MessageFilter({ by: "session" });

	/** @returns `true` 为放行 */
	allow(msg: Message): boolean {
		return this.users.filter(msg) && this.sessions.filter(msg);
	}

	/** 用一层名单数据覆盖当前集合 */
	set(sets: LayerSets): void {
		applySets(this.users, sets.users);
		applySets(this.sessions, sets.sessions);
	}
}

/** 把一组名单灌进 MessageFilter 的集合 (原地替换, 不换实例) */
function applySets(filter: MessageFilter, sets: FilterSets): void {
	filter.blacklist.clear();
	filter.whitelist.clear();
	for (const id of sets.black) filter.blacklist.add(id);
	for (const id of sets.white) filter.whitelist.add(id);
}
