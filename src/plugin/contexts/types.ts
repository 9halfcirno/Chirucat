import type { Stats } from "fs";
import type { Command } from "../../command/types";
import type { Message } from "../../entity/message";
import type { BotActions } from "../../protocols/actions";
import type { BotEvents } from "../../protocols/events";
import type { SessionType } from "../../protocols/session";
import type { SessionPlatformInfo } from "../../internal/session-manager";
import type { UserPlatformInfo } from "../../internal/user-manager";

export type PluginMessageCallback = (message: Message) => unknown;

/** 一条消息回调: 匹配器 + 处理器, 按注册顺序触发 */
export type MessageCallbackEntry = {
	matcher: (message: Message) => boolean;
	handler: PluginMessageCallback;
};

export interface PluginMessageAPI {
	/** 全量接收 */
	all(handler: PluginMessageCallback): void;
	/** 全词匹配 */
	full(text: string, handler: PluginMessageCallback): void;
	/** 前缀匹配 */
	start(prefix: string, handler: PluginMessageCallback): void;
	/** 后缀匹配 */
	end(postfix: string, handler: PluginMessageCallback): void;
	/** 包含 */
	includes(text: string, handler: PluginMessageCallback): void;
	/** 正则匹配 */
	regex(regexp: RegExp, handler: PluginMessageCallback): void;
	/** 自定义匹配 */
	match(predicate: ((msg: Message) => boolean), handler: PluginMessageCallback): void;
}

export interface PluginCommandAPI {
	/**
	 * 注册指令
	 * @param name 指令名, 可包含空格
	 * @param handler 指令回调
	 */
	register(name: string, handler: Command["handler"]): Command;
	/**
	 * 注销指令
	 * @param command 要注销的指令
	 */
	unregister(command: Command): void
	/**
	 * 使用纯文本和参数触发指令
	 * @param name 指令名
	 * @param args 参数
	 */
	exec(name: string, args: (string | number)[]): boolean;
	/**
	 * 对消息进行匹配
	 * @param message 进行匹配的消息
	 * @returns true为匹配到指令, false为未匹配
	 */
	exec(message: Message): boolean;
}

export interface PluginFileSystemAPI {
	/** 存储根目录 */
	root: string;
	/** 
	 * 读取文件
	 * @param path 读取文件的路径
	 * @param encoding 解码方式
	 */
	read(path: string, encoding: BufferEncoding): Promise<string>;
	/** 
	 * 写入文件
	 * @param path 写入文件的路径
	 * @param data 写入的数据
	 */
	write(path: string, data: string | NodeJS.ArrayBufferView): Promise<void>;
	/**
	 * 向文件末尾追加数据
	 * @param path 写入文件的路径
	 * @param data 追加数据
	 */
	append(path: string, data: string | NodeJS.ArrayBufferView): Promise<void>;
	/**
	 * 检查指定文件是否存在
	 * @param path 目标文件是否存在
	 */
	exists(path: string): Promise<boolean>;
	/**
	 * 列出目录下的条目
	 * @param path 目标目录, 缺省为存储根目录
	 */
	list(path?: string): Promise<string[]>;
	/**
	 * 获取文件状态
	 * @param path 目标文件路径
	 */
	stat(path: string): Promise<Stats>;
}



export interface PluginKVAPI {
	/** 初始化kv存储, 需显式调用 */
	init(): void;
	/**
	 * 读取键值
	 * @param key 键
	 * @param defaultValue 键不存在时返回的默认值
	 */
	get<T = unknown>(key: string, defaultValue?: T): T | undefined;
	/**
	 * 写入键值, 值必须可 JSON 序列化 (string/number/boolean/null/object/array)
	 * @param key 键
	 * @param value 值
	 */
	set(key: string, value: unknown): void;
	/**
	 * 键是否存在
	 * @param key 键
	 */
	has(key: string): boolean;
	/**
	 * 删除键
	 * @param key 键
	 * @returns 是否存在并被删除
	 */
	delete(key: string): boolean;
	/** 清空当前插件的全部键值 */
	clear(): void;
	/** 列出全部键 */
	keys(): string[];
	/** 列出全部键值对 */
	entries(): [string, unknown][];
}



export type ActionHandler = (action: BotActions, extra?: Record<string, any>) => any;

export interface PluginBotAPI {
	id: string; // Bot ID
	name: string | null; // Bot名字
}

export interface AdapterPluginBotAPI extends PluginBotAPI{
	dispatch(event: BotEvents): void;
	onAction: (handler: ActionHandler) => void;
}

export interface PluginUserAPI {
	get: (platform: string, id: string) => string;

	query(uuid: string): UserPlatformInfo | null;
}

export interface PluginSessionAPI {
	get: (platform: string, type: SessionType, id: string) => string;
	query: (uuid: string) => SessionPlatformInfo | null
}

