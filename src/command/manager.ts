import type { Message } from "../entity/message";
import CommandParser from "./parser";
import type { Command, CommandManagerOption } from "./types";

export class CommandManager {
	prefix: string = "/";

	/**
	 * 存储指令名 -> 所有指令对象
	 */
	commands = new Map<string, Command[]>();

	constructor(option: CommandManagerOption) {
		if (option.prefix) {
			this.prefix = option.prefix;
		}
	}

	/**
	 * 
	 * @param message 进行匹配的消息
	 * @returns true为匹配到指令, false为未匹配
	 */
	exec(message: Message) {
		let text = message.text;

		if (text.startsWith(this.prefix)) { // 如果以前缀开头
			text = text.slice(this.prefix.length); // 移除前缀
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

			let args = CommandParser.parse(text, {
				argStart: command.length + 1
			})
			for (let com of coms) {
				try {
					com.handler(message, args);
				} catch (e) {
					console.error(`Command execute error:`, e);
				}
			}

			return true;
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
	 * @param command 要移除的指令
	 */
	unregister(command: Command) {
		if (!this.commands.has(command.name)) return; // 没数组的话直接返回

		const arr = this.commands.get(command.name)!;

		let idx = arr.indexOf(command);
		if (idx === -1) return; // 未注册过, 防止 splice(-1, 1) 误删末尾
		arr.splice(idx, 1);
	}
}