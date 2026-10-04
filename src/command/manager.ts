import { Message } from "../entity/message";
import CommandParser from "./parser";
import Logger from "../utils/logger";
import type { HookBus } from "../hooks/bus";

const logger = new Logger("CommandManager");
import type { Command, CommandManagerOption } from "./types";

export class CommandManager {
	prefix: string = "/";

	/**
	 * Hook 总线; 未接入时为 undefined, 跳过 `before.command.handle` 分发。
	 */
	private readonly hookBus?: HookBus;

	/**
	 * 存储指令名 -> 所有指令对象
	 */
	commands = new Map<string, Command[]>();

	constructor(option: CommandManagerOption) {
		if (option.prefix) {
			this.prefix = option.prefix;
		}
		if (option.hookBus) {
			this.hookBus = option.hookBus;
		}
	}

	/**
	 * 使用纯文本和参数触发指令
	 * @param name 指令名
	 * @param args 参数
	 * @returns 命中的指令名, 未命中为 false
	 */
	exec(name: string, args: (string | number)[]): string | false;
	/**
	 * 对消息进行匹配
	 * @param message 进行匹配的消息
	 * @returns 命中的指令名, 未命中为 false
	 */
	exec(message: Message): string | false;

	exec(message: Message | string, args?: (string | number)[]) {
		let text: string;
		if (message instanceof Message) {
			text = message.text;
		} else text = message;

		if (typeof message === "string" || text.startsWith(this.prefix)) { // 如果以前缀开头
			if (typeof message !== "string") text = text.slice(this.prefix.length); // 移除前缀
			let command: string | null = null;
			for (let com of this.commands.keys()) { // O(n)获取前缀最长的指令
				if (text.startsWith(com)) { // 前缀匹配到了
					if (command === null) {
						command = com; continue;
					}
					if (com.length > command.length) {
						command = com; // 如果com比command更长, 就把command改成com
					}
				}
			}

			if (command === null) return false;

			const coms = this.commands.get(command)!;

			let params = args || CommandParser.parse(text, {
				argStart: command.length
			})
			const msgArg = message instanceof Message ? message : null;
			for (let com of coms) {
				// Hook 埋点: 指令执行之前, 可被服务插件取消(跳过该指令处理函数)
				if (this.hookBus?.dispatch("before.command.handle", { message: msgArg, command: com, args: params })) {
					continue;
				}
				try {
					com.handler(msgArg, params);
				} catch (e) {
					logger.error(`Command execute error:`, e);
				}
			}

			return command;
		}
		return false;
	}

	/**
	 * 注册指令
	 * @param command 指令对象
	 */
	register(command: Command) {
		if (!this.commands.has(command.name)) {
			this.commands.set(command.name, [])
		}
		const arr = this.commands.get(command.name)!;

		if (!arr.includes(command)) arr.push(command);
	}

	/**
	 * 移除指令
	 *
	 * 最后一个同名指令被移除后一并删掉该名字的键: 否则指令表里会留下空数组,
	 * exec 仍会“命中”这个名字(返回指令名却不调任何 handler), 把消息从
	 * 插件消息回调里吞掉 —— 全局指令表(服务插件)长期存活, 这种残留尤其明显。
	 */
	unregister(command: Command) {
		if (!this.commands.has(command.name)) return; // 没数组的话直接返回

		const arr = this.commands.get(command.name)!;

		let idx = arr.indexOf(command);
		if (idx === -1) return; // 未注册过, 防止 splice(-1, 1) 误删末尾
		arr.splice(idx, 1);

		if (arr.length === 0) this.commands.delete(command.name);
	}
}