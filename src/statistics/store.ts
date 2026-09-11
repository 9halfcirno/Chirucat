import sqlite from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { StatPoint, StatRange, StatRankItem, StatRecord, StatSummary } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 本地时区偏移(ms)。桶按本地自然小时/自然日对齐, 而非 UTC 边界 */
function zoneOffset(): number {
	return -new Date().getTimezoneOffset() * 60_000;
}

type Where = { sql: string; params: (string | number)[] };

/**
 * 统计存储: 单文件 sqlite。
 *
 * - `message_stat` 明细, 每条消息一行
 * - `message_stat_rollup` 聚合, 明细过期后按 hour → day 逐级模糊化
 *
 * 降采样时聚合与删除在同一事务内完成, 两张表的时间范围因此互不重叠,
 * 查询时直接相加即可, 不会重复计数。
 */
export class StatisticsStore {
	readonly db: sqlite.Database;

	constructor(file: string) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.db = new sqlite(file);
		// WebUI 可能以独立进程读写同一个库, WAL 下读写互不阻塞
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
	}

	init() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS message_stat (
				id            INTEGER PRIMARY KEY AUTOINCREMENT,
				time          INTEGER NOT NULL,
				bot_id        TEXT    NOT NULL,
				platform      TEXT    NOT NULL,
				session_id    TEXT    NOT NULL,
				session_type  TEXT    NOT NULL,
				user_id       TEXT    NOT NULL,
				union_id      TEXT    NOT NULL DEFAULT '',
				text_len      INTEGER NOT NULL DEFAULT 0,
				image_count   INTEGER NOT NULL DEFAULT 0,
				mention_count INTEGER NOT NULL DEFAULT 0,
				filtered      INTEGER NOT NULL DEFAULT 0,
				is_command    INTEGER NOT NULL DEFAULT 0
			);

			CREATE INDEX IF NOT EXISTS idx_message_stat_time ON message_stat(time);
			CREATE INDEX IF NOT EXISTS idx_message_stat_bot_time ON message_stat(bot_id, time);

			CREATE TABLE IF NOT EXISTS message_stat_rollup (
				granularity  TEXT    NOT NULL,
				bucket       INTEGER NOT NULL,
				bot_id       TEXT    NOT NULL,
				platform     TEXT    NOT NULL,
				session_type TEXT    NOT NULL DEFAULT '',
				session_id   TEXT    NOT NULL DEFAULT '',
				count        INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (granularity, bucket, bot_id, platform, session_type, session_id)
			);
		`);
	}

	/** 批量写入明细 */
	insertMany(rows: StatRecord[]) {
		if (rows.length === 0) return;
		const stmt = this.db.prepare(`
			INSERT INTO message_stat
				(time, bot_id, platform, session_id, session_type, user_id, union_id,
				 text_len, image_count, mention_count, filtered, is_command)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertAll = this.db.transaction((list: StatRecord[]) => {
			for (const r of list) {
				stmt.run(
					r.time, r.botId, r.platform, r.sessionId, r.sessionType, r.userId, r.unionId,
					r.textLen, r.imageCount, r.mentionCount, r.filtered ? 1 : 0, r.isCommand ? 1 : 0,
				);
			}
		});
		insertAll(rows);
	}

	/**
	 * 数据降采样: 过期明细 → 小时聚合, 过期小时 → 天聚合(同时丢弃会话维度)。
	 * 聚合与删除同事务, 失败则整体回滚, 不会出现数据丢失或重复。
	 */
	maintain(now: number, detailRetentionMs: number, hourlyRetentionMs: number) {
		const zone = zoneOffset();
		const detailCutoff = now - detailRetentionMs;
		const hourlyCutoff = now - hourlyRetentionMs;

		const toHour = this.db.prepare(`
			INSERT INTO message_stat_rollup
				(granularity, bucket, bot_id, platform, session_type, session_id, count)
			SELECT 'hour', CAST((time + ?) / ? AS INTEGER) * ? - ?, bot_id, platform, session_type, session_id, COUNT(*)
			FROM message_stat
			WHERE time < ?
			GROUP BY CAST((time + ?) / ? AS INTEGER) * ? - ?, bot_id, platform, session_type, session_id
			ON CONFLICT (granularity, bucket, bot_id, platform, session_type, session_id)
			DO UPDATE SET count = count + excluded.count
		`);
		const dropDetail = this.db.prepare(`DELETE FROM message_stat WHERE time < ?`);

		const toDay = this.db.prepare(`
			INSERT INTO message_stat_rollup
				(granularity, bucket, bot_id, platform, session_type, session_id, count)
			SELECT 'day', CAST((bucket + ?) / ? AS INTEGER) * ? - ?, bot_id, platform, '', '', SUM(count)
			FROM message_stat_rollup
			WHERE granularity = 'hour' AND bucket < ?
			GROUP BY CAST((bucket + ?) / ? AS INTEGER) * ? - ?, bot_id, platform
			ON CONFLICT (granularity, bucket, bot_id, platform, session_type, session_id)
			DO UPDATE SET count = count + excluded.count
		`);
		const dropHour = this.db.prepare(`DELETE FROM message_stat_rollup WHERE granularity = 'hour' AND bucket < ?`);

		this.db.transaction(() => {
			toHour.run(zone, HOUR_MS, HOUR_MS, zone, detailCutoff, zone, HOUR_MS, HOUR_MS, zone);
			dropDetail.run(detailCutoff);
			toDay.run(zone, DAY_MS, DAY_MS, zone, hourlyCutoff, zone, DAY_MS, DAY_MS, zone);
			dropHour.run(hourlyCutoff);
		})();
	}

	#where(range: StatRange, column: string): Where {
		const params: (string | number)[] = [range.from, range.to];
		let sql = `${column} >= ? AND ${column} < ?`;
		if (range.botId) {
			sql += " AND bot_id = ?";
			params.push(range.botId);
		}
		return { sql, params };
	}

	summary(range: StatRange): StatSummary {
		const detail = this.#where(range, "time");
		const row = this.db.prepare(`
			SELECT COUNT(*) AS total,
			       COUNT(DISTINCT user_id) AS users,
			       COUNT(DISTINCT session_id) AS sessions,
			       SUM(filtered) AS filtered,
			       SUM(is_command) AS commands,
			       SUM(image_count) AS images
			FROM message_stat WHERE ${detail.sql}
		`).get(...detail.params) as {
			total: number; users: number; sessions: number;
			filtered: number | null; commands: number | null; images: number | null;
		} | undefined;

		const rollup = this.#where(range, "bucket");
		const archived = this.db.prepare(`
			SELECT SUM(count) AS total FROM message_stat_rollup WHERE ${rollup.sql}
		`).get(...rollup.params) as { total: number | null } | undefined;

		const archivedTotal = archived?.total ?? 0;

		return {
			total: (row?.total ?? 0) + archivedTotal,
			users: row?.users ?? 0,
			sessions: row?.sessions ?? 0,
			filtered: row?.filtered ?? 0,
			commands: row?.commands ?? 0,
			images: row?.images ?? 0,
			partial: archivedTotal > 0,
		};
	}

	timeline(range: StatRange, bucketMs: number): StatPoint[] {
		const zone = zoneOffset();

		const detail = this.#where(range, "time");
		const rows = this.db.prepare(`
			SELECT CAST((time + ?) / ? AS INTEGER) * ? - ? AS bucket, COUNT(*) AS count
			FROM message_stat WHERE ${detail.sql}
			GROUP BY bucket
		`).all(zone, bucketMs, bucketMs, zone, ...detail.params) as { bucket: number; count: number }[];

		const rollup = this.#where(range, "bucket");
		const archived = this.db.prepare(`
			SELECT bucket, count FROM message_stat_rollup WHERE ${rollup.sql}
		`).all(...rollup.params) as { bucket: number; count: number }[];

		// 明细与聚合的时间范围互不重叠, 直接累加
		const buckets = new Map<number, number>();
		const add = (time: number, count: number) => buckets.set(time, (buckets.get(time) ?? 0) + count);

		for (const r of rows) add(r.bucket, r.count);
		for (const r of archived) {
			// 聚合粒度可能粗于请求粒度, 统一对齐到请求桶
			add(Math.floor((r.bucket + zone) / bucketMs) * bucketMs - zone, r.count);
		}

		return [...buckets].map(([time, count]) => ({ time, count })).sort((a, b) => a.time - b.time);
	}

	topSessions(range: StatRange, limit: number): StatRankItem[] {
		const where = this.#where(range, "time");
		const rows = this.db.prepare(`
			SELECT session_id AS id, platform, session_type, COUNT(*) AS count
			FROM message_stat WHERE ${where.sql}
			GROUP BY session_id
			ORDER BY count DESC
			LIMIT ?
		`).all(...where.params, limit) as { id: string; platform: string; session_type: string; count: number }[];

		return rows.map(r => ({
			id: r.id,
			count: r.count,
			meta: { platform: r.platform, sessionType: r.session_type },
		}));
	}

	topPlatforms(range: StatRange, limit: number): StatRankItem[] {
		const where = this.#where(range, "time");
		const rows = this.db.prepare(`
			SELECT platform AS id, COUNT(*) AS count
			FROM message_stat WHERE ${where.sql}
			GROUP BY platform
			ORDER BY count DESC
			LIMIT ?
		`).all(...where.params, limit) as { id: string; count: number }[];

		return rows.map(r => ({ id: r.id, count: r.count }));
	}

	/** 已产生统计数据的 Bot id */
	bots(): string[] {
		const rows = this.db.prepare(`
			SELECT bot_id AS id FROM message_stat
			UNION
			SELECT bot_id AS id FROM message_stat_rollup
			ORDER BY id
		`).all() as { id: string }[];
		return rows.map(r => r.id);
	}

	close() {
		this.db.close();
	}
}
