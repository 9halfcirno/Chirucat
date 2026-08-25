import path from "path";
import { PluginManager } from "../plugin/manager";
import { MessageHandler } from "./message-handler";
import type { BotConfig, BotActionCallback } from "./types";
import type { BotEventMeta, BotEvents } from "../protocols/events";
import { EntityFactory } from "../entity/factory";
import type { Core } from "../core";
import { CommandManager } from "../command/manager";
import EventEmitter from "events";

// 虽然不知道继承Emitter有什么用吧
export class Bot extends EventEmitter {
	id: string;
	path: string;
	message = new MessageHandler(this);
	command = new CommandManager({});
	plugin = new PluginManager(this);

	private _actionCallbacks: BotActionCallback[] = [];

	constructor(config: BotConfig, readonly core: Core) {
		super();
		this.path = config.path;
		this.id = config.id;

	}

	async start() {
		await this.plugin.scan("plugins", path.join(this.path, "plugins"));
	}

	async stop() {
		// TODO
	}

	dispatch(event: BotEvents, meta: BotEventMeta) {
		const entity = EntityFactory.from(event, meta);
		if (!entity) return;
		if (entity.type === "message.create") {
			this.message.handle(entity);
		}
	}

	onAction(callback: BotActionCallback) {
		if (this._actionCallbacks.includes(callback)) return; // 防止重入

		this._actionCallbacks.push(callback);
	}
}