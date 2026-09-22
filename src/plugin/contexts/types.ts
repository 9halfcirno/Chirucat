import type { MakeDirectoryOptions, RmOptions, Stats } from "fs";
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
	 * @returns 命中的指令名, 未命中为 false
	 */
	exec(name: string, args: (string | number)[]): string | false;
	/**
	 * 对消息进行匹配
	 * @param message 进行匹配的消息
	 * @returns 命中的指令名, 未命中为 false
	 */
	exec(message: Message): string | false;
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
	 * 删除文件/目录
	 * @param path 要删除的文件路径
	 * @param option 删除选项
	 */
	remove(path: string, option?: RmOptions): Promise<void>;

	/**
	 * 创建文件夹
	 * @param path 目标目录路径
	 * @param option mkdie选项
	 */
	mkdir(path: string, option?: MakeDirectoryOptions): Promise<void>;

	/**
	 * 更改文件名
	 * @param path 要改名的文件路径
	 * @param name 新名字
	 */
	rename(path: string, name: string): Promise<void>;

	/**
	 * 复制文件
	 * @param from 源文件
	 * @param to 目标路径
	 */
	copy(from: string, to: string): Promise<void>;

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

/**
 * 只读文件系统 API: 摘除写入类操作
 *
 * 仅约束正常调用(类型上看不到 write/append), 运行时拦截在 FileSystemAPI 内
 */
export type ReadonlyFsAPI = Omit<PluginFileSystemAPI, "write" | "append">;



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

/**
 * 使插件可操作webui
 * @todo
 */
export interface PluginWebUIAPI {
	/**
	 * 
	 * @param path 注册的路由, 会注册为`/api/bot/${botId}/plugin/${pluginId}/${PATH}`
	 * @param handler 请求处理器, 处理完请求返回响应结果
	 * @returns 
	 */
	route: (path: string, handler: (res: Request) => any | Promise<any>) => void;
}

/**
 * 插件配置的只读视图
 *
 * 配置值由 WebUI 修改; 插件与 WebUI 共享同一个配置实例,
 * 因此每次 get 读到的都是最新值 —— 除非插件自己把返回值缓存了下来。
 *
 * 插件自己的可变状态请使用 `kv` / `fs`; 配置属于用户, 插件只读。
 */
/**
 * 配置变更回调
 * @param key 发生变化的配置项路径(点号分隔), 如 "offset" / "pro-group.extra"
 * @param value 新值
 * @param oldValue 旧值
 */
export type PluginConfigWatcher = (key: string, value: unknown, oldValue: unknown) => void;

export interface PluginConfigAPI {
	/**
	 * 取配置项, 支持点号路径与数组下标:
	 * `get("offset")` / `get("pro-group.extra")` / `get("groups.0.id")`
	 * @param key 属性路径
	 * @param fallback 未配置时的返回值
	 */
	get<T = unknown>(key: string, fallback?: T): T;
	/** 该配置项是否有值 (值为 undefined 视为没有) */
	has(key: string): boolean;
	/** 一份配置值副本 */
	all(): Record<string, any>;
	/**
	 * 监听配置变更
	 *
	 * 仅用户通过 WebUI 改动配置时触发(载入配置不算变更);
	 * 一次更新里每个发生变化的配置项调用一次回调。
	 * 上下文释放时监听自动注销。
	 *
	 * @param handler 变更回调
	 * @returns 取消监听
	 */
	watch(handler: PluginConfigWatcher): () => void;
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

