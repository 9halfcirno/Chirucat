import type { Bot } from "../../bot/bot";
import { StateError } from "../../errors/state-error";
import type { ActionResponses, BotActions } from "../../protocols/actions";
import type { BotEvents } from "../../protocols/events";
import type { SessionType } from "../../protocols/session";
import type { PluginExports } from "../exports";
import type { ConfigManager } from "../../config/manager";
import type { PluginManifest } from "../types";
import { PluginContext } from "./context";
import type { ActionHandler, AdapterPluginBotAPI, PluginSessionAPI, PluginUserAPI } from "./types";
import type { Plugin } from "../plugin";

export class AdapterContext extends PluginContext {
	private actionHandlers: ActionHandler[] = [];
	constructor(plugin: Plugin, exports: PluginExports) {
		if (plugin.manifest.type !== "adapter") throw new Error(`Plugin Context: AdapterContext仅 type: adapter 的插件可创建`)
		super(plugin, exports);
		/**
		 * 为Bot触发一个BotEvent
		 * @param event Bot事件
		 */
		this.bot = {
			id: this._bot.id,
			name: this._bot.name,
			dispatch: (event: BotEvents) => {
				if (this._disposed) {
					if (this._disposed) throw new StateError(`Context已释放, 无法触发事件`);
				}
				this._bot.dispatch(event, {
					adapter: this._manifest.id
				});
			},
			/**
			 * 注册处理Bot动作的方法
			 * @param handler Action处理器
			 */
			onAction: (handler) => {
				this.actionHandlers.push(handler);
			}
		}
	}

	bot: AdapterPluginBotAPI;

	user: PluginUserAPI = {
		get: (platform: string, id: string) => {
			return this._bot.core.user!.get(platform, id)
		},
		query: (uuid: string) => {
			return this._bot.core.user!.query(uuid);
		}
	}

	session: PluginSessionAPI = {
		get: (platform: string, type: SessionType, id: string) => {
			return this._bot.core.session!.get(platform, type, id)
		},
		query: (uuid) => {
			return this._bot.core.session!.query(uuid);
		},
	}

	async handleAction<T extends BotActions>(
		action: T,
		extra?: Record<string, any>
	): Promise<ActionResponses[T["type"]]> {
		let response: ActionResponses[T["type"]] | null = null;

		for (const handler of this.actionHandlers) {
			// handler 抛异常不能让它直接 reject 出去: 本方法的契约是"总能给出响应对象",
			// 否则 msg.reply() 会以一个未捕获异常的形式收场, 比 success:false 更难定位。
			try {
				const r = await handler(action, extra);
				if (r) {
					response = r;
					break;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.logger.error(`适配器处理动作 ${action.type} 时抛出异常: ${msg}`);
				return {
					success: false,
					error: msg,
					code: "ADAPTER_ERROR"
				} as ActionResponses[T["type"]];
			}
		}

		// 如果遍历完都没有 handler 给出响应
		// 直接返回框架层统一的 success: false
		if (!response) {
			// 静默失败会让调用方只看到 success:false 而无从定位, 这里必须留痕:
			// 动作已由 PluginManager 按 meta.adapter 路由到本插件, 所以"没处理"是缺陷, 不是分工
			this.logger.warn(
				`适配器未处理动作 ${action.type}: 插件 ${this._manifest.id} 注册了 ${this.actionHandlers.length} 个Action处理器, ` +
				`均未返回响应`
			);
			return {
				success: false,
				error: "Adapter did not handled this action",
				code: "ACTION_NOT_HANDLED"
			} as ActionResponses[T["type"]];
		}

		return response;
	}

	override dispose(): void {
		super.dispose();
		this.actionHandlers = [];
	}
}