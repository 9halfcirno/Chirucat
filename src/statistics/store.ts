import sqlite from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { StatDirection, StatPoint, StatRange, StatRankItem, StatRecord, StatSummary } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 本地时区偏移(ms)。桶按本地自然小时/自然日对齐, 而非 UTC 边界 */
function zoneOffset(): number {
	return -new Date().getTimezoneOffset() * 60_000;
}

type Where = { sql: string; params: (string | number)[] };

/** 聚合表的主键列表, 建表与 ON CONFLICT 共用, 避免两处不一致 */
const ROLLUP_KEYS = "granularity, bucket, bot_id, platform, session_type, session_id, direction, command";

/** 聚合表列定义 */
const ROLLUP_COLUMNS = `
				granularity  TEXT    NOT NULL,
				bucket       INTEGER NOT NULL,
				bot_id       TEXT    NOT NULL,
				platform     TEXT    NOT NULL,
				session_type TEXT    NOT NULL DEFAULT '',
				session_id   TEXT    NOT NULL DEFAULT '',
				direction    TEXT    NOT NULL DEFAULT 'in',
				command      TEXT    NOT NULL DEFAULT '',
				count        INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (${ROLLUP_KEYS})`;

/**
 * 统计存储: 单文件 sqlite。
 *
 * - `message_stat` 明细, 每条消息一行, `direction` 区分收到与发出
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
		// 先按最新结构建表(对已有的旧表无影响), 再对旧结构做迁移
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS message_stat (
				id            INTEGER PRIMARY KEY AUTOINCREMENT,
				time          INTEGER NOT NULL,
				direction     TEXT    NOT NULL DEFAULT 'in',
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
				is_command    INTEGER NOT NULL DEFAULT 0,
				command       TEXT    NOT NULL DEFAULT ''
			);

			CREATE INDEX IF NOT EXISTS idx_message_stat_time ON message_stat(time);
			CREATE INDEX IF NOT EXISTS idx_message_stat_bot_time ON message_stat(bot_id, time);

			CREATE TABLE IF NOT EXISTS message_stat_rollup (${ROLLUP_COLUMNS}
			);
		`);

		this.#migrate();
	}

	/** 表是否已包含某列 */
	#hasColumn(table: string, column: string): boolean {
		const rows = this.db.pragma(`table_info(${table})`) as { name: string }[];
		return rows.some(row => row.name === column);
	}

	/**
	 * 旧库结构升级: 补齐方向与指令名
	 *
	 * - 明细表直接 ADD COLUMN, 旧数据默认落为收到(in)且未命中指令
	 * - 聚合表的方向/指令名在主键内, 只能重建后迁移
	 *
	 * 以列探测为判定依据, 可重复执行。
	 */
	#migrate() {
		if (!this.#hasColumn("message_stat", "direction")) {
			this.db.exec(`ALTER TABLE message_stat ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'`);
		}
		if (!this.#hasColumn("message_stat", "command")) {
			this.db.exec(`ALTER TABLE message_stat ADD COLUMN command TEXT NOT NULL DEFAULT ''`);
		}

		if (this.#hasColumn("message_stat_rollup", "direction") && this.#hasColumn("message_stat_rollup", "command")) return;

		this.db.transaction(() => {
			this.db.exec(`ALTER TABLE message_stat_rollup RENAME TO message_stat_rollup_legacy`);
			this.db.exec(`CREATE TABLE message_stat_rollup (${ROLLUP_COLUMNS}\n\t\t\t);`);
			this.db.exec(`
				INSERT INTO message_stat_rollup (${ROLLUP_KEYS}, count)
				SELECT granularity, bucket, bot_id, platform, session_type, session_id, 'in', '', count
				FROM message_stat_rollup_legacy
			`);
			this.db.exec(`DROP TABLE message_stat_rollup_legacy`);
		})();
	}

	/** 批量写入明细 */
	insertMany(rows: StatRecord[]) {
		if (rows.length === 0) return;
		const stmt = this.db.prepare(`
			INSERT INTO message_stat
				(time, direction, bot_id, platform, session_id, session_type, user_id, union_id,
				 text_len, image_count, mention_count, filtered, is_command, command)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertAll = this.db.transaction((list: StatRecord[]) => {
			for (const r of list) {
				stmt.run(
					r.time, r.direction, r.botId, r.platform, r.sessionId, r.sessionType, r.userId, r.unionId,
					r.textLen, r.imageCount, r.mentionCount, r.filtered ? 1 : 0, r.isCommand ? 1 : 0, r.command,
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
				(${ROLLUP_KEYS}, count)
			SELECT 'hour', CAST((time + ?) / ? AS INTEGER) * ? - ?, bot_id, platform, session_type, session_id, direction, command, COUNT(*)
			FROM message_stat
			WHERE time < ?
			GROUP BY CAST((time + ?) / ? AS INTEGER) * ? - ?, bot_id, platform, session_type, session_id, direction, command
			ON CONFLICT (${ROLLUP_KEYS})
			DO UPDATE SET count = count + excluded.count
		`);
		const dropDetail = this.db.prepare(`DELETE FROM message_stat WHERE time < ?`);

		const toDay = this.db.prepare(`
			INSERT INTO message_stat_rollup
				(${ROLLUP_KEYS}, count)
			SELECT 'day', CAST((bucket + ?) / ? AS INTEGER) * ? - ?, bot_id, platform, '', '', direction, command, SUM(count)
			FROM message_stat_rollup
			WHERE granularity = 'hour' AND bucket < ?
			GROUP BY CAST((bucket + ?) / ? AS INTEGER) * ? - ?, bot_id, platform, direction, command
			ON CONFLICT (${ROLLUP_KEYS})
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

	/**
	 * 拼查询条件。
	 * @param column  时间列名 (明细为 time, 聚合为 bucket)
	 * @param direction 限定方向; null 表示不区分方向
	 */
	#where(range: StatRange, column: string, direction: StatDirection | null = "in"): Where {
		const params: (string | number)[] = [range.from, range.to];
		let sql = `${column} >= ? AND ${column} < ?`;
		if (direction) {
			sql += " AND direction = ?";
			params.push(direction);
		}
		if (range.botId) {
			sql += " AND bot_id = ?";
			params.push(range.botId);
		}
		return { sql, params };
	}

	summary(range: StatRange): StatSummary {
		const detail = this.#where(range, "time", null);
		const row = this.db.prepare(`
			SELECT SUM(CASE WHEN direction = 'in'  THEN 1 ELSE 0 END) AS total,
			       SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
			       COUNT(DISTINCT CASE WHEN direction = 'in' THEN user_id    END) AS users,
			       COUNT(DISTINCT CASE WHEN direction = 'in' THEN session_id END) AS sessions,
			       SUM(CASE WHEN direction = 'in' THEN filtered      ELSE 0 END) AS filtered,
			       SUM(CASE WHEN direction = 'in' THEN is_command    ELSE 0 END) AS commands,
			       SUM(CASE WHEN direction = 'in' THEN image_count   ELSE 0 END) AS images
			FROM message_stat WHERE ${detail.sql}
		`).get(...detail.params) as {
			total: number | null; sent: number | null; users: number | null; sessions: number | null;
			filtered: number | null; commands: number | null; images: number | null;
		} | undefined;

		const rollup = this.#where(range, "bucket", null);
		const archived = this.db.prepare(`
			SELECT SUM(CASE WHEN direction = 'in'  THEN count ELSE 0 END) AS total,
			       SUM(CASE WHEN direction = 'out' THEN count ELSE 0 END) AS sent,
			       SUM(CASE WHEN direction = 'in' AND command != '' THEN count ELSE 0 END) AS commands
			FROM message_stat_rollup WHERE ${rollup.sql}
		`).get(...rollup.params) as { total: number | null; sent: number | null; commands: number | null } | undefined;

		// 去重类指标只在明细期可得, 有归档数据即视为不完整
		const archivedTotal = archived?.total ?? 0;

		return {
			total: (row?.total ?? 0) + archivedTotal,
			sent: (row?.sent ?? 0) + (archived?.sent ?? 0),
			users: row?.users ?? 0,
			sessions: row?.sessions ?? 0,
			filtered: row?.filtered ?? 0,
			// 指令数由指令名推出, 聚合表保留了该维度, 因此不受明细保留期影响
			commands: (row?.commands ?? 0) + (archived?.commands ?? 0),
			images: row?.images ?? 0,
			partial: archivedTotal > 0,
		};
	}

	timeline(range: StatRange, bucketMs: number): StatPoint[] {
		const zone = zoneOffset();

		const detail = this.#where(range, "time", null);
		const rows = this.db.prepare(`
			SELECT CAST((time + ?) / ? AS INTEGER) * ? - ? AS bucket, direction, COUNT(*) AS count
			FROM message_stat WHERE ${detail.sql}
			GROUP BY bucket, direction
		`).all(zone, bucketMs, bucketMs, zone, ...detail.params) as { bucket: number; direction: StatDirection; count: number }[];

		const rollup = this.#where(range, "bucket", null);
		const archived = this.db.prepare(`
			SELECT bucket, direction, SUM(count) AS count FROM message_stat_rollup WHERE ${rollup.sql}
			GROUP BY bucket, direction
		`).all(...rollup.params) as { bucket: number; direction: StatDirection; count: number }[];

		// 明细与聚合的时间范围互不重叠, 直接累加
		const buckets = new Map<number, StatPoint>();
		const add = (time: number, direction: StatDirection, count: number) => {
			let point = buckets.get(time);
			if (!point) {
				point = { time, count: 0, sent: 0 };
				buckets.set(time, point);
			}
			if (direction === "out") point.sent += count;
			else point.count += count;
		};

		for (const r of rows) add(r.bucket, r.direction, r.count);
		for (const r of archived) {
			// 聚合粒度可能粗于请求粒度, 统一对齐到请求桶
			add(Math.floor((r.bucket + zone) / bucketMs) * bucketMs - zone, r.direction, r.count);
		}

		return [...buckets.values()].sort((a, b) => a.time - b.time);
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
		return this.#topBy(range, "platform", limit);
	}

	/** 指令命中排行 */
	topCommands(range: StatRange, limit: number): StatRankItem[] {
		return this.#topBy(range, "command", limit, "command != ''");
	}

	/**
	 * 按某列的取值汇总排行
	 *
	 * 明细与聚合两侧分别分组后再合并 —— 聚合表保留了平台与指令名维度,
	 * 因此超过明细保留期的范围也能得到完整结果(会话维度例外, 天粒度已丢弃会话)。
	 *
	 * @param column 参与分组的列, 只允许代码内写定的列名
	 * @param filter 额外的过滤条件片段, 不含占位符
	 */
	#topBy(range: StatRange, column: "platform" | "command", limit: number, filter = ""): StatRankItem[] {
		const where = this.#where(range, "time");
		const rows = this.db.prepare(`
			SELECT ${column} AS id, COUNT(*) AS count
			FROM message_stat WHERE ${where.sql}${filter ? ` AND ${filter}` : ""}
			GROUP BY ${column}
		`).all(...where.params) as { id: string; count: number }[];

		const rollup = this.#where(range, "bucket");
		const archived = this.db.prepare(`
			SELECT ${column} AS id, SUM(count) AS count
			FROM message_stat_rollup WHERE ${rollup.sql}${filter ? ` AND ${filter}` : ""}
			GROUP BY ${column}
		`).all(...rollup.params) as { id: string; count: number }[];

		const totals = new Map<string, number>();
		for (const r of [...rows, ...archived]) totals.set(r.id, (totals.get(r.id) ?? 0) + r.count);

		return [...totals]
			.map(([id, count]) => ({ id, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, limit);
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
