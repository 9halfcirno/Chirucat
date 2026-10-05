/**
 * QQ 适配器常量
 *
 * 集中放置所有平台魔法值, 新增接口/文件类型时只需改这里。
 */

/** QQ 开放平台 API 根地址 */
export const BASE_URL = "https://api.bot.qq.com";

/** 平台标识, 用于 user/session 转换与事件 platform 字段 */
export const PLATFORM = "qq";

/**
 * 富媒体文件类型 (file_type)
 *
 * 与官方 `file_type` 取值一一对应, 见富媒体消息概述:
 * 1=图片 2=视频 3=语音 4=文件
 */
export const QQ_FILE_TYPE = {
	image: 1,
	video: 2,
	voice: 3,
	file: 4
} as const;

export type QQFileType = (typeof QQ_FILE_TYPE)[keyof typeof QQ_FILE_TYPE];

/** 媒体消息段类型 -> QQ file_type */
export const MEDIA_FILE_TYPE = {
	image: QQ_FILE_TYPE.image,
	video: QQ_FILE_TYPE.video,
	audio: QQ_FILE_TYPE.voice
} as const;

/** 各 file_type 的默认文件名后缀, 用于分片上传时补一个可读文件名 */
export const MEDIA_FILE_NAME = {
	[QQ_FILE_TYPE.image]: "image",
	[QQ_FILE_TYPE.video]: "video",
	[QQ_FILE_TYPE.voice]: "audio",
	[QQ_FILE_TYPE.file]: "file"
} as const;

/** 文本消息 msg_type */
export const MSG_TYPE_TEXT = 2;
/** 富媒体消息 msg_type */
export const MSG_TYPE_MEDIA = 7;

/**
 * 订阅的网关事件意图位
 *
 * `1 << 25` 即 `GROUP_AND_C2C_EVENT`(群聊与单聊消息)。新增事件类别时在此按位或。
 */
export const INTENTS = 1 << 25;

/** 网关未下发心跳间隔时的兜底值(ms) */
export const DEFAULT_HEARTBEAT_INTERVAL = 30_000;

/** 心跳发出后等待 Op11 ACK 的超时(ms), 超时判定断线 */
export const HEARTBEAT_ACK_TIMEOUT = 10_000;

/** 重连指数退避的上限(ms) */
export const MAX_RECONNECT_DELAY = 30_000;

/** 普通 API 请求超时(ms) */
export const REQUEST_TIMEOUT = 15_000;

/** 上传类请求超时(ms), 官方建议上传接口超时 >= 5s */
export const UPLOAD_TIMEOUT = 60_000;

/** 分片上传默认并发数, 服务端会在 upload_config 中下发实际值 */
export const DEFAULT_UPLOAD_CONCURRENCY = 1;

/** 分片上传默认重试延迟(ms) */
export const DEFAULT_UPLOAD_RETRY_DELAY = 1_000;

/** 分片上传默认重试总时长(ms) */
export const DEFAULT_UPLOAD_RETRY_TIMEOUT = 300_000;

/**
 * `md5_10m` 的取样长度(字节)
 *
 * 官方定义为"文件前 10002432 字节(约 9.54MB)的 MD5", 用于秒传判断。
 */
export const MD5_10M_SIZE = 10_002_432;
