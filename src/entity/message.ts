import type { Bot } from "../bot/bot";
import type { MessageCreateEvent } from "../protocols/event/message";
import type { BotEventMeta } from "../protocols/events";
import type { MessageBlock } from "../protocols/message-block";
import type { Session } from "../protocols/session";
import type { User } from "../protocols/user";
import { Entity } from "./entity";
import type { MessageQuote, MessageReplyOption } from "./types";

export class Message extends Entity {
	id: string;
	text: string;
	blocks: Array<MessageBlock>
	session: Session;
	sender: User;

	quote?: MessageQuote;

	constructor(event: MessageCreateEvent, meta: BotEventMeta, bot?: Bot, quoteChain?: Set<MessageCreateEvent>) {
		if (event.type !== "message.create") throw new TypeError("Message只接收 message.create 事件, 但是收到 " + event.type + " 事件")
		super(event, meta, bot);
		this.id = event.messageId;
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
			this.quote = {
				text: event.quote.text,
				blocks: event.quote.richContent,
				sender: {
					id: event.quote.senderId,
					name: event.quote.senderName,
					unionId: this.bot?.core.user?.getUnion(event.quote.senderId) ?? null
				}
			}
			if (event.quote.messageId) this.quote.id = event.quote.messageId;
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