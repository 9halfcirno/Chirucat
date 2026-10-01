import type { MessageCreateEvent } from "../../src/protocols/event/message";
import type { FilterScope, FilterSets, LayerSets } from "./types";

/**
 * 名单判定
 *
 * 判定完全在内存里做(事件在每条消息的传播路径上都会过一遍过滤器, 不能每次查库),
 * 集合由 FilterManager 在名单改动后重装。
 *
 * 语义与迁移前逐条一致:
 * - 一层里, 用户名单与会话名单各自独立判定, **两者都放行**才算通过;
 * - 单个集合: 黑名单优先命中即拦; 白名单非空时只放行集合内;
 * - 两层 (全局 + Bot 私有) 都要放行 —— 因此 Bot 私有名单实际优先级更高:
 *   全局白名单放行的人或会话, 仍可被某个 Bot 的私有名单排除。
 */
export class FilterJudge {
	/** 全局层: 所有 Bot 共用 */
	private global: LayerSets = emptyLayer();

	/** 各 Bot 的私有层; 没有条目的 Bot 视为不限制 */
	private bots = new Map<string, LayerSets>();

	/**
	 * 一条消息是否放行
	 * @param event 消息事件 (已带框架内的 senderId / sessionId)
	 * @param botId 收到消息的 Bot
	 */
	allow(event: MessageCreateEvent, botId: string): boolean {
		if (!allowLayer(this.global, event)) return false;

		const bot = this.bots.get(botId);
		if (!bot) return true; // 没有私有名单 = 该层不限制
		return allowLayer(bot, event);
	}

	/** 用一层名单数据覆盖某个范围 (空集合 = 该范围不限制) */
	set(scope: FilterScope, botId: string, sets: LayerSets): void {
		if (scope === "global") {
			this.global = sets;
			return;
		}
		this.bots.set(botId, sets);
	}

	/** 丢弃某个 Bot 的私有层 (它的名单行已被删除) */
	dropBot(botId: string): void {
		this.bots.delete(botId);
	}
}

/** 一层判定: 用户与会话都要放行 */
function allowLayer(sets: LayerSets, event: MessageCreateEvent): boolean {
	return allows(sets.users, event.senderId) && allows(sets.sessions, event.sessionId);
}

/** 单个集合的判定: 黑名单优先, 白名单非空时仅放行集合内 */
function allows(sets: FilterSets, key: string): boolean {
	if (sets.black.has(key)) return false;
	if (sets.white.size > 0 && !sets.white.has(key)) return false;
	return true;
}

function emptyLayer(): LayerSets {
	return {
		users: { black: new Set(), white: new Set() },
		sessions: { black: new Set(), white: new Set() },
	};
}
