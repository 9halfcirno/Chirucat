import fs from "fs/promises";
import path from "path";
import { PluginManager } from "../plugin/manager";
import { BotStateFile } from "./state-file";
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
	private _inited = false;
	id: string;
	name: string | null = null;
	path: string;
	message = new MessageHandler(this);
	command = new CommandManager({});
	plugin = new PluginManager(this);

	private _state: BotState;
	private stateFile: BotStateFile;

	/** Bot 是否处于运行中(已启动且未停止) */
	running = false;

	constructor(config: BotConfig, readonly core: Core, state: BotState) {
		super();
		this.path = config.path;
		this.id = config.id;
		this.name = config.name || null;
		this.stateFile = new BotStateFile(path.join(this.path, "state.json"), state);
		this._state = this.stateFile.proxy;
	}


	get state() {
		return this._state;
	}

	/**
	 * 开启Bot, 并设置状态为true(显式写回state.json)
	 */
	async start() {
		if (this.running) return; // 幂等
		this._state.enable = true;
		await this.saveState();

		await this.plugin.scan({ global: "plugins", bot: path.join(this.path, "plugins") });
		await this.plugin.syncState();
		this.running = true;
	}

	/**
	 * 关闭Bot: 卸载全部启用插件, 设置状态为false(显式写回state.json)
	 */
	async stop() {
		if (!this.running) return; // 幂等
		this.running = false; // 先置位, 防止重入
		for (const plugin of [...this.plugin.enabledPlugins]) {
			await this.plugin.unload(plugin.id);
		}
		this._state.enable = false;
		await this.saveState();
	}

	/**
	 * 显式保存状态到 state.json。
	 * 对 state 的修改只更新内存, 不会自动落盘; 需要持久化时必须调用本方法。
	 */
	async saveState() {
		await this.stateFile.save();
	}

	/**
	 * 从状态文件重读状态, 并让插件启停收敛到新状态
	 */
	async syncState() {
		await this.stateFile.reload();
		await this.plugin.syncState();
	}

	/**
	 * 仅从状态文件重读, 不收敛插件(供 BotManager.syncState 等批量收敛场景使用)
	 */
	async reloadState() {
		await this.stateFile.reload();
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