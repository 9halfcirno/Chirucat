/**
 * OneBot11 原始数据结构
 *
 * 描述"实现端下发了什么"。OneBot11 是协议族, 不同实现(NapCat / Lagrange /
 * LLOneBot 等)在可选字段上略有出入, 因此这里以宽松的可选声明为主,
 * 由解析层做兜底判断。
 */

/** 消息段: `{ type: "text", data: { text: "..." } }` */
export interface OneBotSegment {
	type: string;
	data?: Record<string, any>;
}

/** 消息体: 段数组(推荐)或 CQ 码字符串(旧实现) */
export type OneBotMessage = string | OneBotSegment[];

/** 消息发送者信息 */
export interface OneBotSender {
	user_id?: number | string;
	nickname?: string;
	/** 群名片, 优先于昵称展示 */
	card?: string;
	role?: string;
	[key: string]: unknown;
}

/** 消息事件 */
export interface OneBotMessageEvent {
	post_type: "message" | "message_sent";
	message_type?: string;
	sub_type?: string;
	message_id?: number | string;
	message?: OneBotMessage;
	raw_message?: string;
	group_id?: number | string;
	user_id?: number | string;
	self_id?: number | string;
	sender?: OneBotSender;
	time?: number;
	[key: string]: unknown;
}

/**
 * 通知事件
 *
 * 撤回类通知的字段在不同实现间不一致, 这里把已知的几种都列上:
 * - `group_recall`(标准): group_id + user_id(消息作者) + operator_id(撤回者)
 * - `group_msg_delete`(NapCat 等): group_id + message_id + user_id(撤回者)
 * - `friend_recall`(标准): user_id + message_id
 */
export interface OneBotNoticeEvent {
	post_type: "notice";
	notice_type?: string;
	sub_type?: string;
	message_id?: number | string;
	group_id?: number | string;
	user_id?: number | string;
	operator_id?: number | string;
	target_id?: number | string;
	self_id?: number | string;
	time?: number;
	[key: string]: unknown;
}

/** 元事件(心跳/生命周期) */
export interface OneBotMetaEvent {
	post_type: "meta_event";
	meta_event_type?: string;
	self_id?: number | string;
	time?: number;
	[key: string]: unknown;
}

/** 任意下行事件 */
export type OneBotEvent = OneBotMessageEvent | OneBotNoticeEvent | OneBotMetaEvent | Record<string, any>;

/** API 调用响应 */
export interface OneBotApiResponse {
	status?: string;
	retcode?: number;
	data?: any;
	echo?: string | number;
	message?: string;
	msg?: string;
	wording?: string;
	[key: string]: unknown;
}

/** 上行 API 请求 */
export interface OneBotApiRequest {
	action: string;
	params: Record<string, unknown>;
	echo: string;
}

/** 连接参数(由配置读取) */
export interface Ob11Settings {
	/** 正向 WebSocket 地址 */
	url: string;
	/** 访问令牌, 空串表示不携带 */
	accessToken: string;
	/** 断线是否自动重连 */
	reconnect: boolean;
	/** 重连间隔(ms) */
	reconnectInterval: number;
}
