import type { Bot } from "../bot/bot";
import type { MessageCreateEvent } from "../protocols/event/message";
import type { BotEventMeta } from "../protocols/events";
import type { MessageBlock } from "../protocols/message-block";
import type { Session } from "../protocols/session";
import type { User } from "../protocols/user";
import { Entity } from "./entity";
import type { MessageReplyOption } from "./types";

/** 引用消息最大展开层数: 适配器给出过深引用链时的兜底截断 */
const MAX_QUOTE_DEPTH = 8;

/** 带引用链的构造签名, 供子类经 this.constructor 构造引用消息 */
type MessageConstructor = new (
	event: MessageCreateEvent,
	meta: BotEventMeta,
	bot?: Bot,
	quoteChain?: Set<MessageCreateEvent>
) => Message;

export class Message extends Entity {
	text: string;
	blocks: Array<MessageBlock>
	session: Session;
	sender: User;

	quote?: Message;

	constructor(event: MessageCreateEvent, meta: BotEventMeta, bot?: Bot, quoteChain?: Set<MessageCreateEvent>) {
		if (event.type !== "message.create") throw new TypeError("Message只接收 message.create 事件, 但是收到 " + event.type + " 事件")
		super(event, meta, bot);
		this.text = event.text;
		this.blocks = event.richContent;

		this.session = {
			id: event.sessionId,
			type: event.sessionType
		}
		this.sender = {
			id: event.senderId,
			name: event.senderName,
			unionId: this.bot?.core.user?.getUnion(event.senderId) ?? null
		}

		// 引用消息: 沿引用链逐层构造。
		// 链上事件集合拦住成环(自引用/互相引用), MAX_QUOTE_DEPTH 拦住过深链 ——
		// 两者都是无限递归(栈溢出)的入口, 且每层都会新建一条完整 Message
		if (event.quote) {
			const chain = quoteChain ?? new Set<MessageCreateEvent>();
			if (!chain.has(event.quote) && chain.size < MAX_QUOTE_DEPTH) {
				chain.add(event);
				this.quote = new (this.constructor as MessageConstructor)(event.quote, meta, bot, chain);
			}
		}
	}

	reply(message: MessageBlock[] | string, option?: MessageReplyOption) {
		return this.action({
			type: "message.send",
			session: this.session.id,
			message
		})
	}
}