import type { MessageCreateEvent } from "../../src/protocols/event/message";
import { FilterJudge } from "./filter-judge";
import { FilterStore } from "./filter-store";
import type { FilterEntry, FilterKind, FilterMode, FilterScope, FilterTargetType } from "./types";

/**
 * 名单的门面: 存储 + 判定
 *
 * 存在的意义只有一条 —— 名单/模式的**改动**要同时落到两处: 库(持久)与内存判定层。
 * 把这对操作收在一个类里, 端点、事件过滤器与对外导出就不会各写一遍同步逻辑。
 */
export class FilterManager {
	readonly store: FilterStore;
	readonly judge: FilterJudge;

	constructor(dbFile: string) {
		this.store = new FilterStore(dbFile);
		this.judge = new FilterJudge();
	}

	/**
	 * 打开库并装载全部判定层; 幂等
	 *
	 * 不能只装全局层: 两层判定都要放行才有意义, 少装一层等于那层的名单静默失效。
	 * 某个 Bot 也可能只有模式(白名单模式)而没有任何条目, 因此按 `botScopes()` 补齐。
	 */
	init(): void {
		this.store.init();
		this.#reload("global", "");

		for (const botId of this.store.botScopes()) {
			this.#reload("bot", botId);
		}
	}

	/** 按库里的现状重装某一层的判定数据 */
	#reload(scope: FilterScope, botId = ""): void {
		this.judge.set(scope, botId, this.store.layer(scope, botId));
	}

	/** 列出某个范围的名单 */
	list(scope: FilterScope, botId = "", targetType?: FilterTargetType): FilterEntry[] {
		return this.store.list(scope, botId, targetType);
	}

	/** 某个范围的判定模式 */
	mode(scope: FilterScope, botId = ""): FilterMode {
		return this.store.mode(scope, botId);
	}

	/** 设置判定模式, 并让新语义立即生效 */
	setMode(scope: FilterScope, botId: string, mode: FilterMode): FilterMode {
		const saved = this.store.setMode(scope, botId, mode);
		this.#reload(scope, botId);
		return saved;
	}

	/** 加入名单 (已存在时只更新原因), 并让新规则立即生效 */
	add(
		scope: FilterScope,
		botId: string,
		kind: FilterKind,
		targetType: FilterTargetType,
		target: string,
		reason = "",
	): FilterEntry {
		const entry = this.store.add(scope, botId, kind, targetType, target, reason);
		this.#reload(scope, botId);
		return entry;
	}

	/** 按 id 移除名单, 并让改动立即生效 */
	remove(id: number): FilterEntry | null {
		const removed = this.store.remove(id);
		if (removed) this.#reload(removed.scope, removed.botId);
		return removed;
	}

	/** 删除某个 Bot 的全部私有名单与它的模式, 并丢弃它那一层判定 */
	removeByBot(botId: string): number {
		const removed = this.store.removeByBot(botId);
		this.judge.dropBot(botId);
		return removed;
	}

	/** 一条消息是否放行 */
	allow(event: MessageCreateEvent, botId: string): boolean {
		return this.judge.allow(event, botId);
	}

	/** 关闭库连接; 幂等 */
	close(): void {
		this.store.close();
	}
}
