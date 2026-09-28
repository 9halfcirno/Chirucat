import type { ActionResponses, BotActions } from "../../protocols/actions";
import type { BotEvents } from "../../protocols/events";
import type { PluginExports } from "../exports";
import { PluginContext } from "./context";
import type { ActionHandler, AdapterBotAPI, AdapterSessionAPI, AdapterUserAPI } from "./types";
import type { Plugin } from "../plugin";

export class AdapterContext extends PluginContext {
	/** 适配器注册的动作处理器, 按注册顺序依次尝试 */
	private actionHandlers: ActionHandler[] = [];

	/** 适配器视角的 Bot: 追加事件派发与动作处理注册, 运行时值在构造函数里写入 */
	declare bot: AdapterBotAPI;

	/**
	 * 适配器视角的用户: 追加"取或建"
	 *
	 * 适配器是平台标识的来源, 需要在派发事件时落地账号记录;
	 * 普通插件视角(基类)只有 find/query, 不会隐式创建。
	 */
	override user: AdapterUserAPI = {
		find: (platform, id) => this._bot.core.user!.find(platform, id),
		query: (uuid) => this._bot.core.user!.query(uuid),
		get: (platform, id) => this._bot.core.user!.get(platform, id),
		getUnion: (accountId) => this._bot.core.user!.getUnion(accountId)
		
	};

	/** 适配器视角的会话: 追加"取或建", 理由同 user */
	override session: AdapterSessionAPI = {
		find: (platform, type, id) => this._bot.core.session!.find(platform, type, id),
		query: (uuid) => this._bot.core.session!.query(uuid),
		get: (platform, type, id) => this._bot.core.session!.get(platform, type, id),
	};

	constructor(plugin: Plugin, exports: PluginExports, serviceExports: PluginExports | null = null) {
		if (plugin.manifest.type !== "adapter") throw new Error(`Plugin Context: AdapterContext仅 type: adapter 的插件可创建`)
		super(plugin, exports, serviceExports);

		this.bot = {
			id: this._bot.id,
			name: this._bot.name,
			/**
			 * 为Bot触发一个BotEvent
			 * @param event Bot事件
			 */
			dispatch: (event: BotEvents) => {
				this.assertAlive("触发事件");
				this._bot.dispatch(event, {
					adapter: this._manifest.id,
					bot: this._bot.id
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

	async handleAction<T extends BotActions>(
		action: T,
		extra?: Record<string, any>
	): Promise<ActionResponses[T["type"]]> {
		for (const handler of this.actionHandlers) {
			// handler 抛异常不能让它直接 reject 出去: 本方法的契约是"总能给出响应对象",
			// 否则 msg.reply() 会以一个未捕获异常的形式收场, 比 success:false 更难定位。
			try {
				const response = await handler(action, extra);
				if (response) return response;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.logger.error(`适配器处理动作 ${action.type} 时抛出异常: ${msg}`);
				return this.failure<T>(msg, "ADAPTER_ERROR");
			}
		}

		// 如果遍历完都没有 handler 给出响应, 直接返回框架层统一的 success: false。
		// 静默失败会让调用方只看到 success:false 而无从定位, 这里必须留痕:
		// 动作已由 PluginManager 按 meta.adapter 路由到本插件, 所以"没处理"是缺陷, 不是分工
		this.logger.warn(
			`适配器未处理动作 ${action.type}: 插件 ${this._manifest.id} 注册了 ${this.actionHandlers.length} 个Action处理器, ` +
			`均未返回响应`
		);
		return this.failure<T>("Adapter did not handled this action", "ACTION_NOT_HANDLED");
	}

	/** 统一的失败响应: 本方法的契约是"总能给出响应对象", 不允许 undefined */
	private failure<T extends BotActions>(error: string, code: string): ActionResponses[T["type"]] {
		return {
			success: false,
			error,
			code
		} as ActionResponses[T["type"]];
	}

	override dispose(): void {
		super.dispose();
		this.actionHandlers = [];
	}
}
