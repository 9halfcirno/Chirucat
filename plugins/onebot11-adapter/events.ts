import type { MessageCreateEvent, MessageDeleteEvent } from "../../src/protocols/event/message";
import type { BotEvents } from "../../src/protocols/events";
import type { SessionType } from "../../src/protocols/session";
import { blocksToText, parseMessage, type Ob11CodecDeps } from "./codec";
import { PLATFORM } from "./constants";
import type { ContentFilter } from "./filters";
import type { IdentityCache } from "./identity";
import type { OneBotEvent, OneBotMessageEvent, OneBotNoticeEvent } from "./types";

/**
 * 平台事件 -> 框架事件
 *
 * 分拣规则:
 * - `message` / `message_sent` -> `message.create`
 * - `notice` 中的撤回类通知 -> `message.delete`
 *
 * 撤回事件由本适配器承担: OneBot11 会下发撤回通知, 而官方 QQBot 接口没有对应事件。
 * 成员增减(`group_increase` / `group_decrease`)也属于 notice, 但框架协议里
 * `member.add` / `member.remove` 仍是 alpha 且未纳入 `BotEvents` —— 等协议放出来,
 * 往 {@link RECALL_ROUTES} 旁边补一张同构的路由表即可。
 */

/** 事件构建所需的上下文 */
export interface Ob11EventContext {
	/** 编解码依赖(平台标识转换) */
	codec: Ob11CodecDeps;
	/** 平台会话 id -> 框架会话 uuid */
	resolveSessionId: (type: SessionType, platformId: string) => string;
	/** 昵称缓存 */
	identities: IdentityCache;
	/** 当前已知的机器人自身平台 id */
	selfId: string | null;
	/** 事件过滤配置 */
	options: Ob11EventOptions;
}

/** 事件过滤配置(来自插件配置) */
export interface Ob11EventOptions {
	/** 允许派发的会话类型 */
	sessionTypes: string[];
	/** 仅派发群聊中 @ 机器人的消息 */
	atOnly: boolean;
	/** 忽略机器人自身发出的消息 */
	ignoreSelf: boolean;
	/** 内容过滤器 */
	contentFilter: ContentFilter;
	/** 配置项 `contentFilter` */
	contentFilterEnabled: unknown;
	/** 配置项 `filterRules` */
	filterRules: unknown;
}

/**
 * 把一个下行事件转换为框架事件
 * @returns 事件对象; 被过滤/不支持/字段缺失时为 `null`
 */
export function buildOb11Event(event: OneBotEvent, ctx: Ob11EventContext): BotEvents | null {
	switch ((event as { post_type?: unknown }).post_type) {
		case "message":
		case "message_sent":
			return buildMessageEvent(event as OneBotMessageEvent, ctx);
		case "notice":
			return buildNoticeEvent(event as OneBotNoticeEvent, ctx);
		default:
			return null;
	}
}

// -------------------- message.create --------------------

function buildMessageEvent(data: OneBotMessageEvent, ctx: Ob11EventContext): BotEvents | null {
	const options = ctx.options;

	// message_sent 是机器人自己发出的消息(部分实现会回推)
	if (data.post_type === "message_sent" && options.ignoreSelf) return null;

	const messageType = data.message_type;
	if (messageType !== "private" && messageType !== "group") return null;

	// 会话类型过滤
	if (!options.sessionTypes.includes(messageType)) return null;

	const sessionType: SessionType = messageType === "group" ? "group" : "private";
	const rawSessionId = messageType === "group" ? data.group_id : data.user_id;
	if (rawSessionId === undefined || rawSessionId === null) return null;

	const senderPlatformId = data.user_id;
	if (senderPlatformId === undefined || senderPlatformId === null) return null;

	// 忽略机器人自己
	if (options.ignoreSelf && ctx.selfId !== null && String(senderPlatformId) === ctx.selfId) {
		return null;
	}

	const parsed = parseMessage(data.message, ctx.codec);
	const text = blocksToText(parsed.blocks);

	// 仅 @ 机器人(只对群聊生效)
	if (options.atOnly && sessionType === "group") {
		if (ctx.selfId === null) return null;

		const selfUuid = ctx.codec.resolveUserId(ctx.selfId);
		const mentioned = parsed.blocks.some((block) => block.type === "mention" && block.id === selfUuid);
		if (!mentioned) return null;
	}

	// 内容过滤
	if (!options.contentFilter.allows(text, options.contentFilterEnabled, options.filterRules)) {
		return null;
	}

	const senderName = pickSenderName(data);
	ctx.identities.remember(String(senderPlatformId), senderName);

	const messageId = data.message_id === undefined || data.message_id === null
		? ""
		: String(data.message_id);

	const event: MessageCreateEvent = {
		type: "message.create",
		messageId,
		senderId: ctx.codec.resolveUserId(String(senderPlatformId)),
		senderName,
		sessionType,
		sessionId: ctx.resolveSessionId(sessionType, String(rawSessionId)),
		text,
		richContent: parsed.blocks,
		// OneBot 用消息 id 作为引用凭证: 回复时把该 id 放进 reply 段即可
		quoteToken: messageId,
		time: typeof data.time === "number" ? data.time * 1000 : Date.now(),
		platform: PLATFORM,
		extra: {
			message_id: data.message_id,
			message_type: messageType,
			group_id: data.group_id,
			user_id: data.user_id,
			self_id: ctx.selfId,
			raw_message: data.raw_message,
			// 本条消息所回复的消息 id(来自 reply 段), 供插件按需取用
			reply_to_id: parsed.replyToId
		},
		source: data
	};

	return event;
}

/** 昵称取值: 群名片优先于昵称, 都没有则退化为平台 id */
function pickSenderName(data: OneBotMessageEvent): string {
	const sender = data.sender;
	if (sender && typeof sender === "object") {
		if (sender.card) return String(sender.card);
		if (sender.nickname) return String(sender.nickname);
	}
	return String(data.user_id ?? "");
}

// -------------------- message.delete --------------------

/** 一类撤回通知的解析规则 */
interface RecallRoute {
	/** 该通知属于哪种会话 */
	sessionType: SessionType;
	/** 取平台会话 id */
	sessionId: (notice: OneBotNoticeEvent) => string | number | undefined;
	/** 取操作者平台 id */
	operatorId: (notice: OneBotNoticeEvent) => string | number | undefined;
}

/**
 * 撤回通知路由表: 键为 `notice_type`
 *
 * `group_recall` 是标准事件; `group_msg_delete` 是部分实现(NapCat 等)的别名,
 * 两者字段含义一致, 一并支持。`friend_recall` 为私聊撤回。
 */
export const RECALL_ROUTES: Record<string, RecallRoute> = {
	group_recall: {
		sessionType: "group",
		sessionId: (notice) => notice.group_id,
		operatorId: (notice) => notice.operator_id ?? notice.user_id
	},
	group_msg_delete: {
		sessionType: "group",
		sessionId: (notice) => notice.group_id,
		operatorId: (notice) => notice.operator_id ?? notice.user_id
	},
	friend_recall: {
		sessionType: "private",
		sessionId: (notice) => notice.user_id,
		operatorId: (notice) => notice.operator_id ?? notice.user_id
	}
};

function buildNoticeEvent(data: OneBotNoticeEvent, ctx: Ob11EventContext): BotEvents | null {
	const noticeType = data.notice_type ?? "";

	const route = RECALL_ROUTES[noticeType];
	if (!route) return null;

	const messageId = data.message_id;
	if (messageId === undefined || messageId === null) return null;

	const rawSessionId = route.sessionId(data);
	if (rawSessionId === undefined || rawSessionId === null) return null;

	const rawOperatorId = route.operatorId(data);
	if (rawOperatorId === undefined || rawOperatorId === null) return null;

	const operatorPlatformId = String(rawOperatorId);

	const event: MessageDeleteEvent = {
		type: "message.delete",
		messageId: String(messageId),
		operatorId: ctx.codec.resolveUserId(operatorPlatformId),
		// 通知事件不带昵称: 用见过的昵称兜底, 再退化为平台 id(比空字符串可读)
		operatorName: ctx.identities.get(operatorPlatformId) ?? operatorPlatformId,
		sessionType: route.sessionType,
		sessionId: ctx.resolveSessionId(route.sessionType, String(rawSessionId)),
		time: typeof data.time === "number" ? data.time * 1000 : Date.now(),
		platform: PLATFORM,
		extra: {
			notice_type: data.notice_type,
			message_id: data.message_id,
			group_id: data.group_id,
			user_id: data.user_id,
			operator_id: data.operator_id
		},
		source: data
	};

	return event;
}
