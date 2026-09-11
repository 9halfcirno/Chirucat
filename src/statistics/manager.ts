import Logger from "../utils/logger";
import { collect } from "./collector";
import { StatisticsStore } from "./store";
import type { Message } from "../entity/message";
import type {
	StatFlags, StatPoint, StatRange, StatRankItem, StatRecord, StatisticsOptions, StatSummary,
} from "./types";

const logger = new Logger("Statistics");

const DEFAULTS: Required<StatisticsOptions> = {
	flushIntervalMs: 5_000,
	bufferSize: 500,
	detailRetentionDays: 7,
	hourlyRetentionDays: 30,
};

/** 两次降采样之间的最小间隔(ms) */
const MAINTAIN_INTERVAL = 10 * 60 * 1000;

const DAY_MS = 86_400_000;

/**
 * 统计管理器
 *
 * 采集到的记录先进内存缓冲, 定时或写满后批量落盘 ——
 * better-sqlite3 是同步 API, 逐条写入会阻塞事件循环, 批量写把开销压到最低。
 * 构造后自动开始工作, close() 时冲刷缓冲并关闭数据库。
 */
export class StatisticsManager {
	readonly store: StatisticsStore;

	private readonly options: Required<StatisticsOptions>;
	private buffer: StatRecord[] = [];
	private timer: NodeJS.Timeout;
	private closed = false;
	private lastMaintain = 0;

	constructor(file: string, options: StatisticsOptions = {}) {
		this.options = { ...DEFAULTS, ...options };
		this.store = new StatisticsStore(file);
		this.store.init();

		// lastMaintain 初始为 0, 保证首次调用真正执行
		this.maintain();

		this.timer = setInterval(() => this.flush(), this.options.flushIntervalMs);
		// 不让定时器阻止进程退出
		this.timer.unref?.();
	}

	/** 记录一条消息。统计失败不应影响消息处理主流程 */
	record(message: Message, botId: string, flags: StatFlags) {
		if (this.closed) return;
		try {
			this.buffer.push(collect(message, botId, flags));
			if (this.buffer.length >= this.options.bufferSize) this.flush();
		} catch (e) {
			logger.debug(`记录统计失败: ${e instanceof Error ? e.message : e}`);
		}
	}

	/** 把缓冲区写入数据库。写入失败只记日志并丢弃缓冲, 避免无限增长 */
	flush() {
		if (this.buffer.length === 0) return;
		const rows = this.buffer;
		this.buffer = [];

		try {
			this.store.insertMany(rows);
		} catch (e) {
			logger.error(`统计数据写入失败, 已丢弃 ${rows.length} 条记录`, e);
		}

		this.maintain();
	}

	/** 触发降采样, 带最小间隔节流 */
	private maintain() {
		const now = Date.now();
		if (now - this.lastMaintain < MAINTAIN_INTERVAL) return;
		this.lastMaintain = now;
		try {
			this.store.maintain(
				now,
				this.options.detailRetentionDays * DAY_MS,
				this.options.hourlyRetentionDays * DAY_MS,
			);
		} catch (e) {
			logger.error("统计数据整理失败", e);
		}
	}

	/** 冲刷缓冲并关闭数据库; 幂等 */
	close() {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		this.flush();
		try {
			this.store.close();
		} catch (e) {
			logger.error("关闭统计数据库失败", e);
		}
	}

	summary(range: StatRange): StatSummary {
		return this.store.summary(range);
	}

	timeline(range: StatRange, bucketMs: number): StatPoint[] {
		return this.store.timeline(range, bucketMs);
	}

	rank(range: StatRange, by: "session" | "platform", limit = 10): StatRankItem[] {
		return by === "session"
			? this.store.topSessions(range, limit)
			: this.store.topPlatforms(range, limit);
	}

	/** 已产生统计数据的 Bot id */
	bots(): string[] {
		return this.store.bots();
	}
}
