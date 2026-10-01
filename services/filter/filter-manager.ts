import type { MessageCreateEvent } from "../../src/protocols/event/message";
import { FilterJudge } from "./filter-judge";
import { FilterStore } from "./filter-store";
import type { FilterEntry, FilterKind, FilterScope, FilterTargetType } from "./types";

/**
 * 名单的门面: 存储 + 判定
 *
 * 存在的意义只有一条 —— 名单**改动**要同时落到两处: 库(持久)与内存集合(判定用)。
 * 把这对操作收在一个类里, 端点、事件过滤器与对外导出就不会各写一遍同步逻辑。
 */
export class FilterManager {
	readonly store: FilterStore;
	readonly judge: FilterJudge;

	constructor(dbFile: string) {
		this.store = new FilterStore(dbFile);
		this.judge = new FilterJudge();
	}

	/** 打开库并装载全局层; 幂等 */
	init(): void {
		this.store.init();
		this.judge.set("global", "", this.store.layerSets("global", ""));
	}

	/** 打开库并装载某一层的判定集合 */
	#reload(scope: FilterScope, botId = ""): void {
		this.judge.set(scope, botId, this.store.layerSets(scope, botId));
	}

	/** 列出某个范围的名单 */
	list(scope: FilterScope, botId = "", targetType?: FilterTargetType): FilterEntry[] {
		return this.store.list(scope, botId, targetType);
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

	/** 删除某个 Bot 的全部私有名单, 并丢弃它那一层判定 */
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
