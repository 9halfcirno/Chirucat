import type { MessageCreateEvent } from "../protocols/event/message";
import type { BotEventMeta } from "../protocols/events";
import type { MessageBlock } from "../protocols/message-block";
import type { Session } from "../protocols/session";
import type { User } from "../protocols/user";
import { Entity } from "./entity";

export class Message extends Entity {
	text: string;
	blocks: Array<MessageBlock>
	session: Session;
	sender: User;

	constructor(event: MessageCreateEvent, meta: BotEventMeta) {
		if (event.type !== "message.create") throw new TypeError("Message只接收 message.create 事件, 但是收到 " + event.type + " 事件")
		super(event, meta);
		this.text = event.text;
		this.blocks = event.richContent;

		this.session = {
			id: event.sessionId,
			type: event.sessionType
		}
		this.sender = {
			id: event.senderId,
			name: event.senderName
		}

	}
}