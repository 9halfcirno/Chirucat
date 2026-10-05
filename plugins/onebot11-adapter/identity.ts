import { IDENTITY_CACHE_LIMIT } from "./constants";

/**
 * 身份缓存: 平台用户 id -> 昵称
 *
 * 撤回等通知事件只带用户 id, 不带昵称。把消息事件里见过的昵称记下来,
 * 通知事件就能给出可读的操作者名字, 而不是一串数字。
 *
 * 容量固定, 超出后按插入顺序淘汰最早的记录(先删后插使最近使用的条目排到末尾)。
 */
export class IdentityCache {
	private readonly names = new Map<string, string>();

	/** 记下一个用户的昵称 */
	remember(userId: string, name: string): void {
		if (!userId || !name) return;

		this.names.delete(userId);
		this.names.set(userId, name);

		while (this.names.size > IDENTITY_CACHE_LIMIT) {
			const oldest = this.names.keys().next();
			if (oldest.done) break;
			this.names.delete(oldest.value);
		}
	}

	/** 取昵称, 没见过时返回 null */
	get(userId: string): string | null {
		return this.names.get(userId) ?? null;
	}

	clear(): void {
		this.names.clear();
	}
}
