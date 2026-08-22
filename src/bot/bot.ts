import path from "path";
import { PluginManager } from "../plugin/manager";
import { MessageHandler } from "./message-handler";
import { root } from "../utils/root";
import type { Entity } from "../entity/entity";
import { Message } from "../entity/message";

export class Bot {
	
	message = new MessageHandler(this);
	plugin = new PluginManager();
	path: string;

	constructor(dir: string) {
		this.path = dir;
	}

	async start() {

	}

	async stop() {
	}

	dispatch(entity: Entity) {
		if (entity instanceof Message) {
			this.message.handle(entity);
		}
	}
}