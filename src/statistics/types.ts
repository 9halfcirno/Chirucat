import type { SessionType } from "../protocols/session";

/**
 * 消息方向
 *
 * - `in`:  平台 -> Bot, 即 Bot 收到的消息
 * - `out`: Bot -> 平台, 即 Bot 发出的消息(统计的是发送动作, 不代表平台一定投递成功)
 */
export type StatDirection = "in" | "out";

/** 单条消息的统计记录(明细) */
export type StatRecord = {
	/** 事件时间(ms) */
	time: number;
	/** 消息方向 */
	direction: StatDirection;
	/** 来源 Bot id */
	botId: string;
	/** 平台名, 如 qq / discord */
	platform: string;
	/** 会话 uuid */
	sessionId: string;
	/** 会话类型 */
	sessionType: SessionType;
	/** 发送者账号 uuid; 发出的消息没有发送者, 为空串 */
	userId: string;
	/** 发送者跨平台身份, 未绑定时为空串 */
	unionId: string;
	/** 文本总长度 */
	textLen: number;
	/** 图片块数量 */
	imageCount: number;
	/** 提及块数量 */
	mentionCount: number;
	/** 是否被消息过滤器拦截 */
	filtered: boolean;
	/** 是否命中指令 */
	isCommand: boolean;
	/**
	 * 命中的指令名, 未命中时为空串。
	 * 指令名可能包含空格, 因此去重统计不能按首个空格切分。
	 */
	command: string;
};

/** 记录一条消息时的附加标记 */
export type StatFlags = {
	/** 是否被消息过滤器拦截 */
	filtered: boolean;
	/** 命中的指令名; 缺省或空串表示未命中指令 */
	command?: string;
};

/** 记录一条 Bot 发出消息时的上下文 */
export type StatSendMeta = {
	/** 来源 Bot id */
	botId: string;
	/** 平台名 */
	platform: string;
	/** 会话类型 */
	sessionType: SessionType;
};

/** 统计功能配置 */
export type StatisticsOptions = {
	/** 缓冲区落盘间隔(ms), 默认 5000 */
	flushIntervalMs?: number;
	/** 缓冲区条数上限, 达到后立即落盘, 默认 500 */
	bufferSize?: number;
	/** 明细保留天数, 超过后聚合为小时精度, 默认 7 */
	detailRetentionDays?: number;
	/** 小时精度保留天数, 超过后聚合为天精度, 默认 30 */
	hourlyRetentionDays?: number;
};

/** 查询范围 */
export type StatRange = {
	/** 起始时间(ms, 含) */
	from: number;
	/** 结束时间(ms, 不含) */
	to: number;
	/** 限定 Bot, 缺省表示全部 */
	botId?: string;
};

/** 概览统计 */
export type StatSummary = {
	/** 收到的消息总数(含已模糊化的历史数据) */
	total: number;
	/** Bot 发出的消息总数(含已模糊化的历史数据) */
	sent: number;
	/** 活跃用户数(去重, 仅明细期) */
	users: number;
	/** 活跃会话数(去重, 仅明细期) */
	sessions: number;
	/** 被过滤的消息数(仅明细期) */
	filtered: number;
	/** 命中指令的消息数(含已模糊化的历史数据) */
	commands: number;
	/** 图片消息块总数(仅明细期) */
	images: number;
	/** 查询范围超出明细保留期时为 true, 表示去重类指标不完整 */
	partial: boolean;
};

/** 时间线上的一个数据点 */
export type StatPoint = {
	/** 桶起始时间(ms, 本地对齐) */
	time: number;
	/** 该桶内收到的消息数 */
	count: number;
	/** 该桶内 Bot 发出的消息数 */
	sent: number;
};

/** 排行项 */
export type StatRankItem = {
	/** 维度标识(会话 uuid / 平台名) */
	id: string;
	/** 消息数 */
	count: number;
	/** 附加信息, 如会话所属平台与类型 */
	meta?: Record<string, string>;
};

/** 聚合粒度 */
export type RollupGranularity = "hour" | "day";
