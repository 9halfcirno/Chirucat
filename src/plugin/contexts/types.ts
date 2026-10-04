import type { MakeDirectoryOptions, RmOptions, Stats } from "node:fs";
import type { Bot } from "../../bot/bot";
import type { Command } from "../../command/types";
import type { Hooks } from "../../hooks/types";
import type { Message } from "../../entity/message";
import type { ActionResponses, BotActions } from "../../protocols/actions";
import type { BotEvents } from "../../protocols/events";
import type { SessionType } from "../../protocols/session";
import type { SessionPlatformInfo } from "../../internal/session-manager";
import type { UserPlatformInfo } from "../../internal/user-manager";

export type PluginMessageCallback = (message: Message) => unknown;

/** 消息匹配器: 返回 true 表示该消息交给对应处理器 */
export type MessageMatcher = (message: Message) => boolean;

/** 一条消息回调: 匹配器 + 处理器, 按注册顺序触发 */
export type MessageCallbackEntry = {
	matcher: MessageMatcher;
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
	match(predicate: MessageMatcher, handler: PluginMessageCallback): void;
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
	unregister(command: Command): void;
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
	 * @param options 删除选项
	 */
	remove(path: string, options?: RmOptions): Promise<void>;

	/**
	 * 创建文件夹
	 * @param path 目标目录路径
	 * @param options mkdir 选项
	 */
	mkdir(path: string, options?: MakeDirectoryOptions): Promise<void>;

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
 * 只读文件系统 API: 摘除全部写入类操作
 *
 * 只读根(插件代码目录)在类型层面就不提供写入入口,
 * 运行时另有 FileSystemAPI.assertWritable 兜底
 */
export type ReadonlyFsAPI = Omit<
	PluginFileSystemAPI,
	"write" | "append" | "remove" | "mkdir" | "rename" | "copy"
>;



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
 * @todo 尚未实现(apis/webui.ts 仍为空文件)
 */
export interface PluginWebUIAPI {
	/**
	 * 注册一个插件路由
	 * @param path 注册的路由, 会注册为`/api/bot/${botId}/plugin/${pluginId}/${PATH}`
	 * @param handler 请求处理器, 处理完请求返回响应结果
	 */
	route(path: string, handler: (req: Request) => unknown | Promise<unknown>): void;
}

/**
 * 插件配置变更回调
 * @param key 发生变化的配置项路径(点号分隔), 如 "offset" / "pro-group.extra"
 * @param value 新值
 * @param oldValue 旧值
 */
export type PluginConfigWatcher = (key: string, value: unknown, oldValue: unknown) => void;

/**
 * 插件配置的只读视图
 *
 * 配置值由 WebUI 修改; 插件与 WebUI 共享同一个配置实例,
 * 因此每次 get 读到的都是最新值 —— 除非插件自己把返回值缓存了下来。
 *
 * 插件自己的可变状态请使用 `kv` / `fs`; 配置属于用户, 插件只读。
 */
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

/**
 * Action 处理器
 *
 * 必须返回一个响应对象: 动作已按 meta.adapter 路由到对应适配器,
 * "不归我管" 不是合法状态 —— 返回 undefined 会被框架记为未处理
 * (ACTION_NOT_HANDLED), 调用方只能拿到一个没有原因的失败。
 */
export type ActionHandler = <T extends BotActions>(action: T, extra?: Record<string, any>) => Promise<ActionResponses[T["type"]]>;

export interface PluginBotAPI {
	/** Bot ID */
	id: string;
	/** Bot名字 */
	name: string | null;
}

/** 适配器插件专用的 Bot API: 追加事件派发与动作处理器注册 */
export interface AdapterBotAPI extends PluginBotAPI {
	/** 以本适配器为来源派发一个事件 */
	dispatch(event: BotEvents): void;
	/** 注册一个动作处理器 */
	onAction(handler: ActionHandler): void;
}

/**
 * 用户标识 API (插件视图: 只查不建)
 *
 * 插件不应隐式创建账号 —— 落账由适配器收到平台事件时完成。
 * 需要"取或建"时使用适配器视图的 `AdapterUserAPI.get`。
 */
export interface PluginUserAPI {
	/**
	 * 纯查询: 根据平台与平台用户 ID 查找账号 UUID, 不产生任何写入
	 * @returns 账号 UUID; 账号不存在时为 null
	 */
	find(platform: string, id: string): string | null;
	/** 查询账号的平台信息 (按账号 UUID 反查) */
	query(uuid: string): UserPlatformInfo | null;
	/**
	 * 通过用户账号id查询跨平台id, 账号id不存在时返回null
	 * @param accountId 用户账号id
	 */
	getUnion(accountId: string): string | null;
}

/** 适配器插件的用户 API: 适配器是平台账号的来源, 需要落地账号记录 */
export interface AdapterUserAPI extends PluginUserAPI {
	/**
	 * 取平台账号 UUID, 不存在则新建 (会写入账号与内部组记录)
	 * @returns 账号 UUID
	 */
	get(platform: string, id: string): string;
}

/**
 * 会话标识 API (插件视图: 只查不建)
 *
 * 与 `PluginUserAPI` 同理: 会话的创建发生在适配器派发事件时。
 */
export interface PluginSessionAPI {
	/**
	 * 纯查询: 根据平台, 类型与平台会话 ID 查找会话 UUID, 不产生任何写入
	 * @returns 会话 UUID; 会话不存在时为 null
	 */
	find(platform: string, type: SessionType, id: string): string | null;
	/** 查询会话的平台信息 (按会话 UUID 反查) */
	query(uuid: string): SessionPlatformInfo | null;
}

/** 适配器插件的会话 API: 追加"取或建" */
export interface AdapterSessionAPI extends PluginSessionAPI {
	/**
	 * 取平台会话 UUID, 不存在则新建
	 * @returns 会话 UUID
	 */
	get(platform: string, type: SessionType, id: string): string;
}

/**
 * 事件过滤器
 *
 * 返回 false 表示拦截该事件: 它不会再进入收到它的那个 Bot 的处理链。
 * `bot` 是收到事件的 Bot, 便于做"只在某些 Bot 上放行"的判断。
 */
export type PluginEventFilter = (event: BotEvents, bot: Bot) => boolean;

/** 事件观察回调: 事件通过全部过滤器后调用, 返回值不被等待 */
export type PluginEventObserver = (event: BotEvents, bot: Bot) => unknown;

/**
 * Hook API (仅服务插件可用)
 *
 * 与 `PluginEventAPI` 的分工: `event` 作用于事件传播本身(实体构造之前),
 * `hook` 作用于框架内部更细的流程节点 —— 消息处理、指令执行与各模块启停,
 * 并可返回 `{ cancel: true }` 取消后续动作。见 `Hooks` 的 hook 名清单。
 *
 * 只开放 `register`: 分发由框架在埋点处自行调用, 不外放。
 */
export interface PluginHookAPI {
	/**
	 * 注册某 hook 的 handler
	 * @param name hook 名
	 * @param handler 处理器, 返回 `{ cancel: true }` 取消该动作
	 * @returns 注销函数(随上下文释放自动注销)
	 */
	register<N extends keyof Hooks>(name: N, handler: Hooks[N]): () => void;
}

/**
 * 事件 API (仅服务插件可用)
 *
 * 适配器派发的事件先经过所有服务插件的过滤器, 再交给 Bot 处理:
 * 任一过滤器返回 false, 该事件就被丢掉。因此它能改变事件传播本身,
 * 而不只是“收到消息后做点什么” —— 例如只放行 `message.create`,
 * 挡住其他类型的事件。
 *
 * 过滤器抛错时按放行处理并记录日志: 拦截是显式意图, 不能因为一个出错
 * 的过滤器就让事件无声消失。
 */
export interface PluginEventAPI {
	/**
	 * 注册事件过滤器
	 * @param predicate 返回 false 表示拦截该事件
	 */
	filter(predicate: PluginEventFilter): void;
	/**
	 * 注册事件观察回调
	 *
	 * 与 `filter` 的区别: 不返回拦截结果, 只观察; 对通过过滤的事件触发,
	 * 包括 EntityFactory 不认识、不会被任何处理链消费的裸事件。
	 * @param handler 事件回调
	 */
	observe(handler: PluginEventObserver): void;
}
