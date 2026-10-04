import type { Bot } from "../bot/bot";
import type { Command, CommandArgs } from "../command/types";
import type { Core } from "../core";
import type { Message } from "../entity/message";
import type { Plugin } from "../plugin/plugin";

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

/** hook名 */
export type Hooks = {
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

	// 部分的after完全可以注册为
}

export type HookCallback<T> = (data: T) => void | HookBeforeResult;

/**
 * Hook处理器返回的处理结果对象, 可取消处理/修改数据(TODO)等
 */
export type HookBeforeResult = {
	/** 是否取消该Hook后续将执行的动作 */
	cancel?: boolean;

	// TODO: 更多字段
}
