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

/**
 * 判定模式 —— **每一层各有一个**(全局一层, 每个 Bot 的私有层各一个)
 *
 * - `all`:   该层完全不限制: 黑名单与白名单都不参与判定, 名单只作记录
 * - `black`: 只按黑名单拦截; 白名单条目保留但不参与判定
 * - `white`: 白名单参与判定 —— 某个维度(用户 / 会话)的白名单非空时只放行集合内,
 *            该维度名单为空则不受限制; 黑名单仍然优先拦截
 *
 * 默认 `black`。白名单是"显式选择"的收紧手段: 以前"白名单非空即生效"会让随手加进去的
 * 一条记录把所有人都拦下, 那正是它不好用的原因 —— 现在不切到 `white` 就绝不会生效。
 */
export type FilterMode = "all" | "black" | "white";

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

/** 一层名单: 判定模式 + 用户 / 会话各自的集合 */
export type FilterLayer = {
	mode: FilterMode;
	users: FilterSets;
	sessions: FilterSets;
}
