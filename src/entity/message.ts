import type { Bot } from "../bot/bot";
import type { MessageCreateEvent } from "../protocols/event/message";
import type { BotEventMeta } from "../protocols/events";
import type { MessageBlockReceive, MessageBlockSend } from "../protocols/message-block";
import type { Session } from "../protocols/session";
import type { User } from "./user";
import { Entity } from "./entity";
import type { MessageQuote, MessageReplyOption } from "./types";

export class Message extends Entity {
	id: string;

	text: string;
	blocks: Array<MessageBlockReceive>
	session: Session;
	sender: User;

	/** 该消息是否 @ 了本 Bot; 平台未提供时为 null(未知) */
	mentionedSelf: boolean | null;

	quote?: MessageQuote;
	token: string;

	constructor(event: MessageCreateEvent, meta: BotEventMeta, bot: Bot) {
		if (event.type !== "message.create") throw new TypeError("Message只接收 message.create 事件, 但是收到 " + event.type + " 事件")
		super(event, meta, bot);
		this.id = event.messageId;
		this.text = event.text;
		this.blocks = event.richContent;
		this.token = event.quoteToken;
		this.mentionedSelf = event.mentionedSelf ?? null;

		this.session = {
			id: event.sessionId,
			type: event.sessionType,
			unionId: this.bot?.core.session?.unionOf(event.sessionId) ?? null,
		}
		this.sender = {
			id: event.senderId,
			name: event.senderName,
			unionId: this.bot?.core.user?.getUnion(event.senderId) ?? null,
			permission: 0 // 默认均为0，即没有任何权限
		}

		// 引用消息
		if (event.quote) {
			this.quote = {
				text: event.quote.text,
				blocks: event.quote.richContent,
				sender: {
					id: event.quote.senderId,
					name: event.quote.senderName,
					unionId: this.bot?.core.user?.getUnion(event.quote.senderId) ?? null,
					permission: 0
				}
			}
			if (event.quote.messageId) this.quote.id = event.quote.messageId;
		}
	}

	/**
	 * 以当前消息进行被动回复
	 * @param message 消息内容
	 * @param option 消息发送选项
	 * @returns 消息响应结果
	 */
	reply(message: MessageBlockSend[] | string, option?: MessageReplyOption) {
		return this.action({
			type: "message.send",
			session: this.session.id,
			message,
			quote: typeof option?.quote === "boolean" ?
				(option.quote ? this.token : null) :
				(option?.quote || null)
		})
	}

	/**
	 * 撤回该消息对象对应的消息, 注意!通常该消息为用户消息而非Bot发送的消息, 可能需要管理员等权限
	 * @returns 是否撤回成功
	 */
	delete() {
		return this.action({
			type: "message.delete",
			session: this.session.id,
			id: this.id
		})
	}
}

/**
 * 将消息快按顺序拼接为字符串
 * @param blocks 消息块数组
 * @returns 
 */
export function concatBlocks(blocks: (MessageBlockReceive | MessageBlockSend)[]): string {
	let text = "";
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				text += block.text;
				break;
			case "mention":
				text += `@${(block as { name: string }).name || block.id}`;
				break;
			case "image":
				text += `[图片: ${block.url ?? "Buffer"}]`;
				break;
			case "video":
				text += `[视频: ${block.url ?? "Buffer"}]`
				break;
			case "audio":
				text += `[音频: ${block.url ?? "Buffer"}]`
				break;
		}
	}
	return text;
}