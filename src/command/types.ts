import type { Message } from "../entity/message";

export type Command = {
	/** 指令名 */
	name: string;
	/** 指令处理 */
	handler: (message: Message, args: CommandArgs) => void;
}


export type CommandManagerOption = {
	/** 指令前缀 */
	prefix?: string;
}

export type CommandParseConfig = {
	/**
	 * 参数开始的位置(用于跳过指令名的空格), 传0视为从第一个空格开始
	 */
	argStart?: number | void;
	/**
	 * 是否将数字参数转为number, 默认为true
	 */
	number?: boolean | void;
	/**
	 * 是否解析字符串(即引号包括的参数), 默认为true
	 */
	string?: boolean | void;
}

export type CommandArgs = Array<string | number>