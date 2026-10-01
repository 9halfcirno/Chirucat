import type { MessageCreateEvent } from "../../src/protocols/event/message";
import type { FilterLayer, FilterMode, FilterScope, FilterSets } from "./types";

/**
 * 名单判定
 *
 * 判定完全在内存里做(事件在每条消息的传播路径上都会过一遍过滤器, 不能每次查库),
 * 判定层由 FilterManager 在名单/模式改动后重装。
 *
 * 语义:
 * - 两层 (全局 + Bot 私有) 都要放行 —— 因此 Bot 私有层实际优先级更高:
 *   全局放行的人或会话, 仍可被某个 Bot 的私有层拦下;
 * - 每层有自己的模式:
 *   - `all`:   该层不限制(黑白名单都不参与);
 *   - `black`: 只按黑名单拦; 白名单不参与;
 *   - `white`: 黑名单照旧优先拦截, 白名单非空的维度只放行集合内(为空的维度不限制);
 * - 同一层里用户名单与会话名单各自独立(各看各的集合), 两者都放行才算通过。
 */
export class FilterJudge {
	/** 全局层: 所有 Bot 共用 */
	private global: FilterLayer = emptyLayer("black");

	/** 各 Bot 的私有层; 没有条目的 Bot 视为不限制 */
	private bots = new Map<string, FilterLayer>();

	/**
	 * 一条消息是否放行
	 * @param event 消息事件 (已带框架内的 senderId / sessionId)
	 * @param botId 收到消息的 Bot
	 */
	allow(event: MessageCreateEvent, botId: string): boolean {
		if (!allowLayer(this.global, event)) return false;

		const bot = this.bots.get(botId);
		if (!bot) return true; // 没有私有层 = 该层不限制
		return allowLayer(bot, event);
	}

	/** 用一层判定数据(模式 + 集合)覆盖某个范围 */
	set(scope: FilterScope, botId: string, layer: FilterLayer): void {
		if (scope === "global") {
			this.global = layer;
			return;
		}
		this.bots.set(botId, layer);
	}

	/** 丢弃某个 Bot 的私有层 (它的名单与模式已被删除) */
	dropBot(botId: string): void {
		this.bots.delete(botId);
	}
}

/** 一层判定: 模式不限制就直接放行, 否则用户与会话都要放行 */
function allowLayer(layer: FilterLayer, event: MessageCreateEvent): boolean {
	if (layer.mode === "all") return true;

	return allows(layer.users, event.senderId, layer.mode)
		&& allows(layer.sessions, event.sessionId, layer.mode);
}

/**
 * 单个集合的判定
 * - 黑名单在任何非 `all` 模式下都优先拦截;
 * - 白名单只在 `white` 模式下参与, 且集合为空时表示"该维度不限制"(否则切到白名单模式
 *   却只配了用户名单时, 会话维度会把所有人拦下 —— 那不是"白名单"该有的行为)。
 */
function allows(sets: FilterSets, key: string, mode: FilterMode): boolean {
	if (sets.black.has(key)) return false;
	if (mode === "white" && sets.white.size > 0 && !sets.white.has(key)) return false;
	return true;
}

function emptyLayer(mode: FilterMode): FilterLayer {
	return {
		mode,
		users: { black: new Set(), white: new Set() },
		sessions: { black: new Set(), white: new Set() },
	};
}
