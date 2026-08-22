import type { Message } from "../entity/message";

export class MessageFilter {
	constructor() {
		
	}

	/**
	 * 
	 * @param msg 
	 * @returns `true`为放行, `false`为阻止
	 */
	filter(msg: Message): boolean {
		return !msg.text.includes("fuck");
	}
}