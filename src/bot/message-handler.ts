import type { Message } from "../entity/message";
import type { Bot } from "./bot";
import { MessageFilter } from "./message-filter";

export class MessageHandler {
	filter = new MessageFilter();

	constructor(private bot: Bot) {
		
	}

	handle(msg: Message) {
		let skip = this.filter.filter(msg);

		if (skip) {
			console.log(msg);
			
		}
	}
}