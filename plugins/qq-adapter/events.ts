import type { MessageCreateEvent, MessageQuote } from "../../src/protocols/event/message";
import type { BotEvents } from "../../src/protocols/events";
import type { MessageBlockReceive } from "../../src/protocols/message-block";
import type { SessionType } from "../../src/protocols/session";
import { attachmentsToBlocks, parseContent, stripBotMention } from "./codec";
import { PLATFORM } from "./config";
import type { QQMessageData, QQUser, QQWebSocketPayload } from "./types";

/**
 * 平台事件 -> 框架事件
 *
 * 路由以表驱动: 新增一类消息事件只需要往 {@link MESSAGE_ROUTES} 加一行,
 * 不需要改动解析逻辑本身。
 *
 * 本模块是纯函数(平台标识转换通过 {@link QQEventDeps} 注入), 因此可被自检脚本直接调用。
 */

/** 事件构建所需的框架能力 */
export interface QQEventDeps {
	/** 平台用户 id -> 框架账号 uuid */
	resolveUserId: (platformId: string) => string;
	/** 平台会话 id -> 框架会话 uuid */
	resolveSessionId: (type: SessionType, platformId: string) => string;
}

/** 一类消息事件的解析规则 */
export interface QQMessageRoute {
	/** 该事件属于哪种会话 */
	sessionType: SessionType;
	/** 取平台会话 id; 取不到返回 undefined, 该事件被丢弃 */
	sessionId: (data: QQMessageData) => string | undefined;
	/** 取发送者平台 id; 取不到返回 undefined, 该事件被丢弃 */
	senderId: (data: QQMessageData) => string | undefined;
}

/**
 * 取用户 openid
 *
 * 平台在不同事件里用不同字段名承载同一个身份(member_openid / user_openid / id),
 * 这里统一收口, 避免每个调用点各写一遍 `||` 链。
 */
export function pickUserId(user: QQUser | undefined): string | undefined {
	if (!user) return undefined;
	return user.member_openid || user.user_openid || user.id || undefined;
}

/** 消息事件路由表: 键为网关下发的 `t` */
export const MESSAGE_ROUTES: Record<string, QQMessageRoute> = {
	// 群聊: 仅 @机器人 时下发
	GROUP_AT_MESSAGE_CREATE: {
		sessionType: "group",
		sessionId: (data) => data.group_openid,
		senderId: (data) => pickUserId(data.author)
	},
	// 群聊: 全量消息(需平台开通)
	GROUP_MESSAGE_CREATE: {
		sessionType: "group",
		sessionId: (data) => data.group_openid,
		senderId: (data) => pickUserId(data.author)
	},
	// 单聊
	C2C_MESSAGE_CREATE: {
		sessionType: "private",
		sessionId: (data) => pickUserId(data.author),
		senderId: (data) => pickUserId(data.author)
	}
};

/**
 * 把一个网关数据包解析为框架事件
 *
 * @param payload 网关下行数据包
 * @param deps 平台标识转换能力
 * @returns 事件对象; 非消息事件或缺少关键字段时为 `null`
 */
export function buildQQEvent(payload: QQWebSocketPayload, deps: QQEventDeps): BotEvents | null {
	const t = payload.t;
	if (!t) return null;

	const route = MESSAGE_ROUTES[t];
	if (!route) return null;

	const data = payload.d as QQMessageData | undefined;
	if (!data || typeof data !== "object") return null;

	const sessionPlatformId = route.sessionId(data);
	if (!sessionPlatformId) return null;

	const senderPlatformId = route.senderId(data);
	if (!senderPlatformId) return null;

	return buildMessageCreate(data, route, sessionPlatformId, senderPlatformId, deps);
}

/**
 * 构造 `message.create` 事件
 *
 * @param data 平台事件数据
 * @param route 命中的路由规则
 * @param sessionPlatformId 平台会话 id
 * @param senderPlatformId 发送者平台 id
 * @param deps 平台标识转换能力
 */
export function buildMessageCreate(
	data: QQMessageData,
	route: QQMessageRoute,
	sessionPlatformId: string,
	senderPlatformId: string,
	deps: QQEventDeps
): MessageCreateEvent {
	const raw = (data.content ?? "").trim();
	const text = stripBotMention(raw, data.mentions);

	// 被提及用户昵称表, 用于补全提及消息段的 name
	const names = new Map<string, string>();
	for (const user of data.mentions ?? []) {
		const platformId = pickUserId(user);
		if (platformId) names.set(platformId, user.username ?? "");
	}

	const richContent: MessageBlockReceive[] = parseContent(text, {
		resolveId: (platformId) => deps.resolveUserId(platformId),
		names
	});

	// 图片/视频/语音附件追加为对应的媒体消息段
	richContent.push(...attachmentsToBlocks(data.attachments));

	// 空消息(如纯图片且无文本)时兜底一个空文本段, 保证 blocks 非空
	if (richContent.length === 0) richContent.push({ type: "text", text });

	const event: MessageCreateEvent = {
		type: "message.create",
		messageId: data.id ?? "",
		senderId: deps.resolveUserId(senderPlatformId),
		senderName: data.author?.username ?? "",
		sessionType: route.sessionType,
		sessionId: deps.resolveSessionId(route.sessionType, sessionPlatformId),
		text,
		richContent,
		quoteToken: resolveQuoteToken(data),
		time: Date.now(),
		platform: PLATFORM,
		// 被动回复需要原样回传的 msg_id
		extra: { msg_id: data.id },
		source: data
	};

	const quote = buildQuote(data, deps);
	if (quote) event.quote = quote;

	return event;
}

/**
 * 从 `message_scene.ext` 中取出引用 Token(msg_idx)
 *
 * 该字段不一定存在, 且不同事件类型格式可能不同: 取不到时返回空字符串,
 * 不能因为一个可选字段就让整个事件派发失败。
 */
export function resolveQuoteToken(data: QQMessageData): string {
	const ext = data.message_scene?.ext;
	if (!Array.isArray(ext)) return "";

	for (const kv of ext) {
		if (typeof kv === "string" && kv.startsWith("msg_idx=")) {
			return kv.slice("msg_idx=".length);
		}
	}
	return "";
}

/**
 * 从 `msg_elements` 解析被引用消息
 *
 * 仅当 `message_type === 103` 且 `msg_elements` 非空时返回对象。
 */
export function buildQuote(data: QQMessageData, deps: QQEventDeps): MessageQuote | undefined {
	if (data.message_type !== 103) return undefined;

	const elements = data.msg_elements;
	if (!Array.isArray(elements) || elements.length === 0) return undefined;

	// msg_elements[0] 通常是被引用的原始消息
	const quoted = elements[0];
	if (!quoted) return undefined;

	const quotedText = (quoted.content ?? "").trim();
	// 没有作者就当是当前消息作者说的 —— 引用作者缺失时总得有个归属
	const author = quoted.author ?? data.author;
	const authorPlatformId = pickUserId(author);

	const richContent: MessageBlockReceive[] = [{ type: "text", text: quotedText }];

	// 被引用消息的图片附件(平台只为引用消息下发附件, 不含提及数组)
	for (const attachment of quoted.attachments ?? []) {
		const contentType = attachment?.content_type ?? "";
		if (!attachment?.url || !contentType.startsWith("image/")) continue;
		richContent.push({ type: "image", url: attachment.url });
	}

	return {
		text: quotedText,
		richContent,
		senderId: authorPlatformId ? deps.resolveUserId(authorPlatformId) : "",
		senderName: author?.username ?? ""
	};
}
