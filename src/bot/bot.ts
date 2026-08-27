import path from "path";
import { PluginManager } from "../plugin/manager";
import { MessageHandler } from "./message-handler";
import type { BotConfig, BotState } from "./types";
import type { BotEventMeta, BotEvents } from "../protocols/events";
import { EntityFactory } from "../entity/factory";
import type { Core } from "../core";
import { CommandManager } from "../command/manager";
import EventEmitter from "events";
import type { BotActions } from "../protocols/actions";

// 虽然不知道继承Emitter有什么用吧
export class Bot extends EventEmitter {
	id: string;
	name: string | null = null;
	path: string;
	message = new MessageHandler(this);
	command = new CommandManager({});
	plugin = new PluginManager(this);

	constructor(config: BotConfig, readonly core: Core, private _state: BotState) {
		super();
		this.path = config.path;
		this.id = config.id;
		this.name = config.name || null;
	}

	get state() {
		return this._state;
	}

	async start() {
		await this.plugin.scan("plugins", path.join(this.path, "plugins"));

		await this.plugin.load(this._state.plugins) // 用bot state加载插件
	}

	async stop() {
		// TODO
	}

	dispatch(event: BotEvents, meta: BotEventMeta) {
		const entity = EntityFactory.create(event, meta, this);
		if (!entity) return;
		if (entity.type === "message.create") {
			this.message.handle(entity);
		}
	}

	/**
	 * 将Action转发给对应的适配器插件
	 * @param action Action对象
	 * @param adapter 适配器插件的id
	 * @param extra 额外数据, 应从对应event.extra取
	 */
	async action(action: BotActions, adapter: string, extra?: Record<string, any>) {
		this.plugin.handleAction(action, adapter, extra);
	}
}