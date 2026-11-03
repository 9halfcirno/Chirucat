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

/**
 * 发送类动作的默认超时(ms)
 *
 * `message.send` 不只是一次文本下发: 视频/音频/大图片由协议端自行下载并上传,
 * 耗时常常远超普通文本。用 {@link API_TIMEOUT} 会让适配器先判定超时、而协议端
 * 仍在处理 —— 最终消息照样送达, 调用方却拿到一条“发送失败”。
 *
 * 因此发送单独用更长的默认值; 超过该时长才认为结果未知。
 */
export const DEFAULT_SEND_TIMEOUT = 300_000;

/** 发送超时的硬上限(ms): 配置写离谱值时的兜底 */
export const MAX_SEND_TIMEOUT = 600_000;

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
