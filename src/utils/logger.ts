/**
 * 日志工具
 *
 * 两级结构：
 *  - Logger：日志产生端，各模块创建自己的实例；
 *  - LogStream：日志分发总线，订阅者可以是未来的文件写入器、WebUI 推送器等。
 *
 * 所有 Logger 默认把日志条目写入全局 defaultLogStream，
 * 未来接入文件 / WebUI 时只需订阅该流，即可拿到全项目日志。
 */

/** 日志级别（数组顺序即级别从低到高，可用于过滤） */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** 单条日志条目 */
export interface LogEntry {
    /** 时间戳（毫秒），用于排序与存储 */
    readonly timestamp: number;
    /** 格式化后的可读时间 */
    readonly time: string;
    readonly level: LogLevel;
    /** 产生日志的模块名 */
    readonly name: string;
    /** 原始参数 */
    readonly args: readonly unknown[];
    /** 序列化后的文本，供文件 / WebUI 直接使用 */
    readonly message: string;
}

export function formatTime(date: Date = new Date()): string {
    const pad = (n: number) => n.toString().padStart(2, "0");

    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());

    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());
    const second = pad(date.getSeconds());

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/** 将单个参数序列化为可读文本（处理 Error 与循环引用） */
function formatArg(arg: unknown): string {
    if (arg instanceof Error) {
        return arg.stack ?? `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === "string") {
        return arg;
    }
    if (typeof arg === "object" && arg !== null) {
        try {
            const seen = new WeakSet<object>();
            const json = JSON.stringify(arg, (_key, value) => {
                if (typeof value === "object" && value !== null) {
                    if (seen.has(value)) {
                        return "[Circular]";
                    }
                    seen.add(value);
                }
                return value;
            });
            return json ?? String(arg);
        } catch {
            return String(arg);
        }
    }
    return String(arg);
}

/** 将多个参数序列化为单行文本，供文件 / WebUI 使用 */
export function formatArgs(args: readonly unknown[]): string {
    return args.map(formatArg).join(" ");
}

/**
 * 日志流：接收 Logger 产生的条目并分发给所有订阅者，
 * 同时保留最近的历史供后加入的订阅者（如 WebUI 页面）回放。
 *
 * 分发是同步的；异步的订阅者（文件写入、WebSocket 推送）应自行缓冲，
 * 单个订阅者抛出的错误不会影响其他订阅者。
 */
export class LogStream {
    private readonly listeners = new Set<(entry: LogEntry) => void>();
    private readonly history: LogEntry[] = [];
    private readonly capacity: number;

    constructor(options: { capacity?: number } = {}) {
        this.capacity = options.capacity ?? 1000;
    }

    /** 订阅日志流，返回退订函数 */
    subscribe(listener: (entry: LogEntry) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 获取历史日志快照（供后加入的订阅者回放） */
    getHistory(): readonly LogEntry[] {
        return [...this.history];
    }

    /** 写入一条日志（由 Logger 内部调用） */
    push(entry: LogEntry): void {
        if (this.history.length >= this.capacity) {
            this.history.shift();
        }
        this.history.push(entry);

        for (const listener of this.listeners) {
            try {
                listener(entry);
            } catch (error) {
                console.error("[LogStream] 订阅者处理日志时出错:", error);
            }
        }
    }
}

/** 全局默认日志流：所有 Logger 默认写入这里 */
export const defaultLogStream = new LogStream();

export interface LoggerOptions {
    /**
     * 日志流；默认使用全局 defaultLogStream，
     * 传入 null 可禁用流输出（仅保留控制台输出）。
     */
    stream?: LogStream | null;
}

export default class Logger {
    private name: string;
    private readonly stream: LogStream | null;

    constructor(name: string, options: LoggerOptions = {}) {
        this.name = name;
        this.stream = options.stream === undefined ? defaultLogStream : options.stream;
    }

    private write(level: LogLevel, args: unknown[]): void {
        const now = new Date();
        const time = formatTime(now);

        // 控制台输出（保持原有格式）
        const consoleFn =
            level === "error" ? console.error
            : level === "warn" ? console.warn
            : level === "debug" ? console.debug
            : console.log;
        consoleFn(`[${time}][${level.toUpperCase()}][${this.name}]`, ...args);

        // 写入日志流（供文件 / WebUI 等订阅者使用）
        this.stream?.push({
            timestamp: now.getTime(),
            time,
            level,
            name: this.name,
            args,
            message: formatArgs(args),
        });
    }

    log(...args: any[]): void {
        this.write("info", args);
    }

    error(...args: any[]): void {
        this.write("error", args);
    }

    warn(...args: any[]): void {
        this.write("warn", args);
    }

    info(...args: any[]): void {
        this.write("info", args);
    }

    debug(...args: any[]): void {
        this.write("debug", args);
    }
}
