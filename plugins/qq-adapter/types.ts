/**
 * QQ 开放平台原始数据结构
 *
 * 这些类型描述"平台下发了什么", 只用于适配器内部解析;
 * 派发给框架的事件一律使用 `src/protocols/` 中的协议类型。
 *
 * 平台字段几乎都是可选的(不同事件携带的字段不同, 部分字段官方文档也标为可能缺失),
 * 因此这里全部按可选声明, 由解析层做兜底, 而不是用断言赌平台一定下发。
 */

/** 网关地址响应 */
export interface QQGatewayInfo {
	url?: string;
	message?: string;
	[key: string]: unknown;
}

/** WebSocket 下行数据包 */
export interface QQWebSocketPayload<T = Record<string, any>> {
	/** 操作码 */
	op: number;
	/** 数据体 */
	d?: T;
	/** 事件类型, 仅 op=0 时有值 */
	t?: string;
	/** 序列号, 用于 Resume */
	s?: number;
}

/** 消息中的用户信息 */
export interface QQUser {
	/** 用户 openid */
	user_openid?: string;
	/** 群成员 openid */
	member_openid?: string;
	/** 部分事件直接给 id */
	id?: string;
	/** 用户 union_openid, 可用于跨平台识别 */
	union_openid?: string;
	/** 昵称 */
	username?: string;
	/** 是否机器人自己, 仅 mentions 中携带 */
	is_you?: boolean;
}

/** 富媒体附件 */
export interface QQAttachment {
	/** MIME 类型, 如 image/png */
	content_type?: string;
	/** 资源地址 */
	url?: string;
	/** 文件名 */
	filename?: string;
	/** 字节数 */
	size?: number;
}

/** 被引用消息元素 */
export interface QQMessageElement {
	/** 纯文本内容 */
	content?: string;
	/** 作者 */
	author?: QQUser;
	/** 附件 */
	attachments?: QQAttachment[];
	/** 元素消息类型 */
	message_type?: number;
}

/** 消息场景, 引用消息的 token 在其中以 `msg_idx=` 形式下发 */
export interface QQMessageScene {
	/** 场景扩展键值对, 形如 `["msg_idx=xxx"]` */
	ext?: string[];
	[key: string]: unknown;
}

/** 消息类事件的 d 字段 */
export interface QQMessageData {
	/** 消息 id */
	id?: string;
	/** 消息内容 */
	content?: string;
	/** 消息类型, 103 表示该消息引用了另一条消息 */
	message_type?: number;
	/** 消息场景 */
	message_scene?: QQMessageScene;
	/** 引用消息元素 */
	msg_elements?: QQMessageElement[];
	/** 发送者 */
	author?: QQUser;
	/** 被提及的用户 */
	mentions?: QQUser[];
	/** 附件 */
	attachments?: QQAttachment[];
	/** 群 openid, 仅群聊事件有 */
	group_openid?: string;
	/** 平台时间戳 */
	timestamp?: string;
	[key: string]: unknown;
}

/** READY / RESUMED 事件的 d 字段 */
export interface QQReadyData {
	/** 会话 id, 断线重连时用于 Resume */
	session_id?: string;
	/** 机器人用户信息 */
	user?: QQUser;
	[key: string]: unknown;
}

/** 消息发送目标: 群聊或单聊 */
export interface QQSendTarget {
	type: "group" | "private";
	/** 群 openid 或 用户 openid */
	id: string;
}

/**
 * 待上传的媒体来源
 *
 * 与协议 `MessageBlockSend` 的媒体块对应: `url` 与 `buffer` 互斥。
 * 新增来源类型(如本地文件路径)只需在这里加一个分支, 并补上
 * `MediaUploader.upload` 的处理。
 */
export type MediaSource =
	| { kind: "url"; url: string }
	| { kind: "buffer"; buffer: NodeJS.ArrayBufferView };

/** 分片上传的单个分片描述 */
export interface QQUploadPart {
	/** 分片序号, 从 0 开始 */
	index?: number;
	/** 预签名上传地址 */
	presigned_url?: string;
	/** 该分片的大小(字节, 字符串形式) */
	block_size?: string;
}

/** 预上传响应中的上传配置 */
export interface QQUploadConfig {
	/** 并发数 */
	concurrency?: number;
	/** 重试总时长(秒) */
	retry_timeout?: number;
	/** 重试延迟(秒) */
	retry_delay?: number;
}

/** 预上传响应 */
export interface QQUploadPrepareResult {
	/** 上传任务 id */
	upload_id?: string;
	/** 分块大小(字节, 字符串形式) */
	block_size?: string;
	/** 分片列表 */
	parts?: QQUploadPart[];
	/** 上传配置 */
	upload_config?: QQUploadConfig;
}

/** 上传接口响应 */
export interface QQUploadFileResult {
	/** 文件唯一 id */
	file_uuid?: string;
	/** 用于发送消息的 media.file_info */
	file_info?: string;
	/** file_info 有效期(秒) */
	ttl?: number;
	/** 直接发送时的消息 id, 仅 srv_send_msg=true 时返回 */
	id?: string;
	[key: string]: unknown;
}

/** 发送消息响应 */
export interface QQSendMessageResult {
	/** 消息 id */
	id?: string;
	/** 引用信息 */
	ext_info?: {
		/** 引用 token */
		ref_idx?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}
