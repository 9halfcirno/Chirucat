import type { Bot } from "../bot/bot";
import type { Command, CommandArgs } from "../command/types";
import type { Core } from "../core";
import type { Message } from "../entity/message";
import type { Plugin } from "../plugin/plugin";
import type { ActionResponses, BotActions } from "../protocols/actions";

/**
 * 指令处理 Hook 的载体: 完整执行上下文。
 *
 * `message` 为 null 表示由纯文本触发的指令(见 `CommandManager.exec(string, args)`),
 * 此时没有可关联的 `Message` 对象。
 */
export type HookCommandContext = {
	/** 触发指令的消息; 纯文本触发时为 null */
	message: Message | null;
	/** 命中的指令对象 */
	command: Command;
	/** 解析/传入的指令参数 */
	args: CommandArgs;
};

/**
 * Action 前后两个埋点的载体
 *
 * 名字里的 `send` 是**框架内部对“把 Action 交给适配器”的称呼**(与收派对应),
 * 不是动作类型 `message.send` —— 这两个埋点覆盖所有 Action, 包括 `message.delete`。
 */
export type HookActionContext = {
	/** 本次动作 */
	action: BotActions;
	/** 实际执行该动作的适配器插件 id */
	adapter: string;
	/** 发送该Action的 bot 的 id */
	bot: string;
	/** 框架随动作回传的适配器私有数据 */
	extra: void | Record<string, any>;
};

/**
 * Action 完成 Hook 的载体
 *
 * 在适配器**已经返回响应**之后触发 —— 无论成功失败都会拿到响应, 由 handler 自己看
 * `response.success`。放在一个 hook 里而不是 success / failed 两个, 是因为:
 * - 插件只为成功路径注册一次, 不必处理两个名字;
 * - 失败也是事实, 想统计失败率的插件不用再猜自己漏了哪一半。
 */
export type HookActionResult = HookActionContext & {
	/** 发起该动作的 Bot id (动作本身只带 session, 推不出是哪个 Bot) */
	bot: string;
	/** 适配器返回的响应 */
	response: ActionResponses[BotActions["type"]];
};

/**
 * before 类钩子: 埋点在事情**发生之前**, 返回值可取消
 *
 * 这一组的共同语义是“还有机会拦住”。框架用 `dispatch` 分发: 按注册顺序调用,
 * 第一个返回 `{ cancel: true }` 就停下并告诉调用方已取消。
 */
export type BeforeHooks = {
	/** 核心初始化之前, 传入未init的Core */
	"before.core.init": HookCallback<Core>;
	/** Bot初始化之前, 传入未start的Bot */
	"before.bot.enable": HookCallback<Bot>;
	/** Plugin初始化之前, 传入未enable的Plugin */
	"before.plugin.enable": HookCallback<Plugin>;

	/** 消息处理之前, 传入已构造的Message对象 */
	"before.message.handle": HookCallback<Message>;
	/** 指令处理之前, 传入命中的指令执行上下文 */
	"before.command.handle": HookCallback<HookCommandContext>;

	/** Action 转发给适配器之前 */
	"before.action.send": HookCallback<HookActionContext>;
};

/**
 * after 类钩子: 埋点在事情**已经发生之后**, 只通知
 *
 * 这一组用 `HookNotice` 而不是 `HookCallback`: 没有返回值, 因此**类型上**就写不出
 * `{ cancel: true }` —— 事情已经发生了, 取消没有意义, 让作者能写出来再默默忽略比
 * 直接不允许更坏。框架用 `notify` 分发: 全部 handler 都会被调用, 不短路。
 *
 * ## 什么情况下才该往这里加
 *
 * 只有**确实存在“结果”这个事实、且至少有一个真实消费者**时才加。否则“每个 before
 * 都配一个 after”看起来对称, 实际只是多一次分发与一份没人订阅的接口。
 *
 * 目前只有一个:
 * - `after.action.send` —— 框架里唯一能确认“一条消息真的被发出去了”的地方。
 *   受理人服务靠它抵消回声(自己发的消息会被另一个适配器当成入站消息收到);
 * - 没有 `after.message.handle` / `after.command.handle`: 它们没有这类结果。要
 *   “消息处理完了做点什么”用 `ctx.message` 或 `ctx.event.observe`, 那里本来就是
 *   通知语义, 不必再开一个埋点。
 */
export type AfterHooks = {
	/** Action 完成后 (适配器已返回响应) */
	"after.action.send": HookNotice<HookActionResult>;
};

/** 全部 hook 名: 两张表分开定义, 但注册时用同一个名字空间 */
export type Hooks = BeforeHooks & AfterHooks;

export type HookCallback<T> = (data: T) => void | HookBeforeResult;

/**
 * after 类钩子的处理器: 只通知, 无返回值
 *
 * 允许返回 Promise 是为了同时接受 async 函数; 它的拒绝会被框架记成日志,
 * 不会拖垮主流程(参见 HookBus.notify)。
 */
export type HookNotice<T> = (data: T) => void | Promise<void>;

/**
 * Hook处理器返回的处理结果对象, 可取消处理/修改数据(TODO)等
 */
export type HookBeforeResult = {
	/** 是否取消该Hook后续将执行的动作 */
	cancel?: boolean;

	// TODO: 更多字段
}
