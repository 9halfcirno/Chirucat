import type { Bot } from "../bot/bot";
import type { ActionResponses, BotActions } from "../protocols/actions";
import type { BotEventMeta, BotEvents } from "../protocols/events";
import { v6 as uuidv6 } from "uuid";

export class Entity {
	uuid = uuidv6();
	type: BotEvents["type"];
	time: number;
	/** 该字段建议配合UserManager使用, 不应直接使用, 如果插件要用...也行吧 */
	platform: string;

	/** 事件携带的额外数据 */
	extra: Record<string, any>;

	/** 插件间共享的实体附加数据, 由服务插件在 before.message.handle 等阶段写入 */
	data: Record<string, any> = {};

	readonly source: Record<string, any> | null;

	constructor(readonly event: BotEvents, readonly meta: BotEventMeta, protected bot: Bot) {
		this.type = event.type;
		this.time = event.time;
		this.platform = event.platform;
		this.extra = event.extra || {};

		this.source = event.source ? event.source : null;
	}

	action<T extends BotActions>(action: T): Promise<ActionResponses[T["type"]]> {
		return this.bot.action(action, this.meta.adapter, this.extra)
	}

	/**
	 * 取事件来源适配器的逃生舱导出 (正式的逃生舱; `source` 只是事件原始数据)
	 *
	 * 每次调用实时查询注册表, 不要缓存返回值 —— 适配器卸载后条目即被释放,
	 * 缓存下来的只是失效对象。适配器未发布逃生舱时返回 null, 调用方自行降级。
	 */
	escape<T = any>(): T | null {
		return this.bot.adapterExports.getExports(this.meta.adapter) ?? null;
	}
}