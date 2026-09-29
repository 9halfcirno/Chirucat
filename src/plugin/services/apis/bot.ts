import type { Bot } from "../../../bot/bot";
import type { BotManager } from "../../../bot/manager";

/**
 * 单个 Bot 的只读快照
 *
 * 服务插件不属于任何 Bot, 因此拿不到 Bot 实例 —— 只通过快照看它的身份与运行态。
 */
export type BotInfo = {
	/** Bot id */
	id: string;
	/** 展示名; 未配置时为 null */
	name: string | null;
	/** 是否正在运行 */
	running: boolean;
	/** 持久化期望态: 是否期望启用 */
	enabled: boolean;
};

/**
 * 服务插件视角的 Bot 管理
 *
 * 只放两类能力:
 * - 只读快照: 有哪些 Bot、各自跑没跑;
 * - 启停: 与 `BotManager` 同语义(不传 id 时作用于全部期望启用的 Bot)。
 *
 * 刻意不提供 `scan` / `syncState` / `dispose`: 那是框架自己的发现与生命周期编排,
 * 该由 Core 决定何时做; 也不交出 `Bot` 实例 —— 那会把插件管理器、消息处理链
 * 一并漏给服务插件, 越过这个视图的边界。
 *
 * 管理器用 `#bots`(ECMAScript 私有)持有: 运行时也拿不到它, 不然 `as any` 一步
 * 就能绕回 `scan` / `dispose`。
 */
export class BotAPI {
	readonly #bots: BotManager;

	constructor(bots: BotManager) {
		this.#bots = bots;
	}

	/** 全部已注册 Bot 的只读快照, 按注册顺序 */
	list(): BotInfo[] {
		return [...this.#bots.bots.values()].map(toBotInfo);
	}

	/** 单个 Bot 的只读快照; 未注册时为 null */
	get(id: string): BotInfo | null {
		const bot = this.#bots.bots.get(id);
		return bot ? toBotInfo(bot) : null;
	}

	/** 该 id 的 Bot 是否已注册 */
	has(id: string): boolean {
		return this.#bots.bots.has(id);
	}

	/**
	 * 启动 Bot
	 * @param ids 目标 Bot id; 缺省启动全部期望启用的 Bot
	 */
	start(...ids: string[]): Promise<void> {
		return this.#bots.start(...ids);
	}

	/**
	 * 停止 Bot
	 * @param ids 目标 Bot id; 缺省停止全部期望启用的 Bot
	 */
	stop(...ids: string[]): Promise<void> {
		return this.#bots.stop(...ids);
	}
}

function toBotInfo(bot: Bot): BotInfo {
	return {
		id: bot.id,
		name: bot.name,
		running: bot.running,
		enabled: bot.state.get().enable === true,
	};
}
