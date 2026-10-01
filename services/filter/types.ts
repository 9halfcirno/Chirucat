/**
 * 黑白名单的数据形状
 *
 * 名单只属于这个服务插件: 框架代码不再引用这些类型(它连名单入口都没有了)。
 */

/** 名单范围: 全局 还是 某个 Bot 私有 */
export type FilterScope = "global" | "bot";
/** 名单类型 */
export type FilterKind = "black" | "white";
/** 名单对象: 用户(账号) 或 会话(群 / 频道) */
export type FilterTargetType = "user" | "session";

/** 一条名单 */
export type FilterEntry = {
	id: number;
	scope: FilterScope;
	/** scope=bot 时所属的 Bot id; 全局名单为空串 */
	botId: string;
	kind: FilterKind;
	targetType: FilterTargetType;
	/** 被列入名单的账号 UUID 或会话 UUID */
	target: string;
	reason: string;
	createdAt: number;
}

/** 一类对象的可判定集合 */
export type FilterSets = {
	black: Set<string>;
	white: Set<string>;
}

/** 一层名单: 用户与会话各自独立 */
export type LayerSets = {
	users: FilterSets;
	sessions: FilterSets;
}
