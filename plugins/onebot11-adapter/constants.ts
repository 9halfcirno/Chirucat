/**
 * OneBot11 适配器常量
 */

/**
 * 平台标识
 *
 * 固定为 `"qq"`: OneBot11 实现(NapCat / Lagrange / LLOneBot 等)承载的就是 QQ,
 * 与官方 QQBot 适配器共用平台命名空间, 使同一批账号/会话记录可以互相打通。
 *
 * 注意: 该值属于既有数据的命名空间, 改动会让已落库的账号与会话记录全部失联。
 */
export const PLATFORM = "qq";

/** API 调用(echo 往返)超时(ms) */
export const API_TIMEOUT = 15_000;

/** 断线重连默认间隔(ms) */
export const DEFAULT_RECONNECT_INTERVAL = 5_000;

/**
 * CQ 码匹配
 *
 * 形如 `[CQ:image,file=xxx,yyy=zzz]`; 参数部分允许为空。
 */
export const CQ_PATTERN = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;

/** 身份缓存容量上限(条), 超出后淘汰最早的记录 */
export const IDENTITY_CACHE_LIMIT = 500;
