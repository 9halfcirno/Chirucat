import fs from "node:fs";
import path from "node:path";
import sqlite from "better-sqlite3";
import type {
	FilterEntry,
	FilterKind,
	FilterLayer,
	FilterMode,
	FilterScope,
	FilterTargetType,
} from "./types";

/**
 * 名单存储
 *
 * 库文件在服务插件自己的数据目录里 (`data/services/chirucat-filter/filter.db`, 目录名
 * 是清单里的插件 id), 由本类自己打开与关闭 —— 框架的内部库 (`data/internal.db`) 不再
 * 参与名单: 它里面遗留的 `filter_list` 表已废弃, 框架既不读也不写。
 *
 * 名单对象有两类:
 * - user:    账号 (account UUID), 判定时看事件的 senderId
 * - session: 会话 (session UUID), 判定时看事件的 sessionId, 用于群 / 频道
 *            私聊会话与用户一一对应, 因此不单独支持, 由用户名单覆盖
 *
 * 范围分两级 (global / bot), 两级在判定时都要放行 —— 见 FilterJudge。
 * 每一层还有自己的**判定模式**(`filter_mode` 表, 见 FilterMode), 名单与模式分开存:
 * 只设置模式而没有任何条目的范围是合法的。
 */
export class FilterStore {
	db: sqlite.Database | null = null;

	/** 库文件 */
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	/** 打开库并建表; 幂等 */
	init(): void {
		if (this.db) return;

		// 目录不存在时 sqlite 无法创建文件, 先保证目录存在
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		this.db = new sqlite(this.file);
		// 与框架其它库同口径: WAL 让读写互不阻塞, busy_timeout 避免并发写直接失败
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");

		this.db.exec(CREATE_TABLE);
		this.db.exec(CREATE_INDEX);
		this.db.exec(CREATE_MODE_TABLE);
		this.#migrate();
	}

	/** 当前连接; 未初始化或已关闭时给出明确错误, 而不是空指针异常 */
	private get conn(): sqlite.Database {
		if (!this.db || !this.db.open) throw new Error(`名单库不可用 (file="${this.file}")`);
		return this.db;
	}

	/** 表是否已包含某列 */
	#hasColumn(table: string, column: string): boolean {
		const rows = this.conn.pragma(`table_info(${table})`) as { name: string }[];
		return rows.some(row => row.name === column);
	}

	/**
	 * 老库升级: 补上 target_type。
	 *
	 * SQLite 不能直接修改约束, 而新结构把 target_type 纳入了唯一键, 因此
	 * 只能重建表后搬迁数据 (旧数据一律视为用户名单)。以列探测为判定依据,
	 * 可重复执行。
	 */
	#migrate() {
		if (this.#hasColumn("filter_list", "target_type")) return;

		this.conn.transaction(() => {
			this.conn.exec(`ALTER TABLE filter_list RENAME TO filter_list_legacy`);
			this.conn.exec(CREATE_TABLE);
			this.conn.exec(`
				INSERT INTO filter_list (id, scope, bot_id, kind, target_type, target, reason, created_at)
				SELECT id, scope, bot_id, kind, 'user', target, reason, created_at FROM filter_list_legacy
			`);
			this.conn.exec(`DROP TABLE filter_list_legacy`);
			// 旧索引随表被重命名后一并丢弃, 这里为新表重建
			this.conn.exec(CREATE_INDEX);
		})();
	}

	/** 列出某个范围的名单; 可按对象类型筛选 */
	list(scope: FilterScope, botId = "", targetType?: FilterTargetType): FilterEntry[] {
		const params: string[] = [];
		let where = scope === "global"
			? `scope = 'global'`
			: `scope = 'bot' AND bot_id = ?`;
		if (scope === "bot") params.push(botId);
		if (targetType) {
			where += " AND target_type = ?";
			params.push(targetType);
		}

		const rows = this.conn.prepare(`SELECT * FROM filter_list WHERE ${where} ORDER BY target_type, kind, id`).all(...params);
		return (rows as RawEntry[]).map(toEntry);
	}

	/** 某个范围的一层判定数据(模式 + 用户 / 会话各自的集合) */
	layer(scope: FilterScope, botId = ""): FilterLayer {
		return toLayer(this.list(scope, botId), this.mode(scope, botId));
	}

	/**
	 * 某个范围的判定模式
	 * @returns 从未设置过时返回默认模式(`black`)
	 */
	mode(scope: FilterScope, botId = ""): FilterMode {
		const row = this.conn.prepare(`SELECT mode FROM filter_mode WHERE scope = ? AND bot_id = ?`)
			.get(scope, scope === "bot" ? botId : "") as { mode: string } | undefined;
		return toMode(row?.mode) ?? DEFAULT_MODE;
	}

	/**
	 * 设置某个范围的判定模式
	 * @returns 落库后的模式(非法值收敛为默认模式)
	 */
	setMode(scope: FilterScope, botId: string, mode: FilterMode): FilterMode {
		const saved = toMode(mode) ?? DEFAULT_MODE;
		this.conn.prepare(`
			INSERT INTO filter_mode (scope, bot_id, mode) VALUES (?, ?, ?)
			ON CONFLICT(scope, bot_id) DO UPDATE SET mode = excluded.mode
		`).run(scope, scope === "bot" ? botId : "", saved);
		return saved;
	}

	/**
	 * 有私有名单或私有模式的 Bot id
	 *
	 * 装载判定层时要按它补齐 —— 否则重启后 Bot 私有层要等到有人碰过这个 Bot 的名单
	 * 才生效(全局层是每层都要放行的两层判定, 少一层等于名单静默失效)。
	 * 只有模式没有条目的 Bot 也在这里: 那种层是合法的(例如"只放行白名单")。
	 */
	botScopes(): string[] {
		const rows = this.conn.prepare(`
			SELECT bot_id FROM filter_list WHERE scope = 'bot'
			UNION
			SELECT bot_id FROM filter_mode WHERE scope = 'bot'
		`).all() as { bot_id: string }[];

		return rows.map(row => row.bot_id).filter(botId => botId !== "");
	}

	/**
	 * 添加一项名单; 同一 (范围, Bot, 类型, 对象类型, 对象) 已存在时只更新原因。
	 * @returns 落库后的条目
	 */
	add(
		scope: FilterScope,
		botId: string,
		kind: FilterKind,
		targetType: FilterTargetType,
		target: string,
		reason = "",
	): FilterEntry {
		const scopedBotId = scope === "bot" ? botId : "";
		this.conn.prepare(`
			INSERT INTO filter_list (scope, bot_id, kind, target_type, target, reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(scope, bot_id, kind, target_type, target) DO UPDATE SET reason = excluded.reason
		`).run(scope, scopedBotId, kind, targetType, target, reason, Date.now());

		const row = this.conn.prepare(`
			SELECT * FROM filter_list
			WHERE scope = ? AND bot_id = ? AND kind = ? AND target_type = ? AND target = ?
		`).get(scope, scopedBotId, kind, targetType, target) as RawEntry;

		return toEntry(row);
	}

	/**
	 * 按 id 删除一项
	 * @returns 被删除的条目; 不存在时返回 null
	 */
	remove(id: number): FilterEntry | null {
		return this.conn.transaction(() => {
			const row = this.conn.prepare('SELECT * FROM filter_list WHERE id = ?').get(id) as RawEntry | undefined;
			if (!row) return null;

			this.conn.prepare('DELETE FROM filter_list WHERE id = ?').run(id);
			return toEntry(row);
		})();
	}

	/** 删除某个 Bot 的全部私有名单与它的模式 (Bot 被删除时调用), 返回删除的名单条数 */
	removeByBot(botId: string): number {
		return this.conn.transaction(() => {
			const changes = this.conn.prepare(`DELETE FROM filter_list WHERE scope = 'bot' AND bot_id = ?`).run(botId).changes;
			this.conn.prepare(`DELETE FROM filter_mode WHERE scope = 'bot' AND bot_id = ?`).run(botId);
			return changes;
		})();
	}

	/** 关闭库连接; 幂等 */
	close(): void {
		if (!this.db) return;
		this.db.close();
		this.db = null;
	}
}

const CREATE_TABLE = `
	CREATE TABLE IF NOT EXISTS filter_list (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		scope       TEXT    NOT NULL,               -- global | bot
		bot_id      TEXT    NOT NULL DEFAULT '',    -- scope=bot 时所属的 Bot id
		kind        TEXT    NOT NULL,               -- black | white
		target_type TEXT    NOT NULL DEFAULT 'user',-- user | session
		target      TEXT    NOT NULL,               -- 账号 UUID 或会话 UUID
		reason      TEXT    NOT NULL DEFAULT '',
		created_at  INTEGER NOT NULL,
		UNIQUE (scope, bot_id, kind, target_type, target)
	);
`;

const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_filter_list_scope ON filter_list(scope, bot_id, kind);`;

/**
 * 判定模式表
 *
 * 与名单分开存: 一个范围可以只设置模式(例如"这个 Bot 只放行白名单")而没有任何条目,
 * 那种情况没有行可挂, 只有 filter_list 的话装不进判定层。
 */
const CREATE_MODE_TABLE = `
	CREATE TABLE IF NOT EXISTS filter_mode (
		scope  TEXT NOT NULL,                 -- global | bot
		bot_id TEXT NOT NULL DEFAULT '',      -- scope=bot 时所属的 Bot id
		mode   TEXT NOT NULL DEFAULT 'black', -- all | black | white
		PRIMARY KEY (scope, bot_id)
	);
`;

/** 全部模式; 用于收敛库里的值 */
const MODES: readonly FilterMode[] = ["all", "black", "white"];
/** 默认模式: 名单开箱即按黑名单工作, 白名单要显式切到 `white` 才生效 */
const DEFAULT_MODE: FilterMode = "black";

/** 把库里的值收敛成合法模式; 不认识的值按"没有设置过"处理 */
function toMode(value: unknown): FilterMode | null {
	return MODES.includes(value as FilterMode) ? value as FilterMode : null;
}

type RawEntry = {
	id: number;
	scope: FilterScope;
	bot_id: string;
	kind: FilterKind;
	target_type: FilterTargetType;
	target: string;
	reason: string;
	created_at: number;
}

function toEntry(row: RawEntry): FilterEntry {
	return {
		id: row.id,
		scope: row.scope,
		botId: row.bot_id,
		kind: row.kind,
		targetType: row.target_type,
		target: row.target,
		reason: row.reason,
		createdAt: row.created_at,
	};
}

/** 把条目按对象类型分到用户/会话两组集合, 并带上该层的模式 */
function toLayer(entries: FilterEntry[], mode: FilterMode): FilterLayer {
	const layer: FilterLayer = {
		mode,
		users: { black: new Set(), white: new Set() },
		sessions: { black: new Set(), white: new Set() },
	};

	for (const entry of entries) {
		const target = entry.targetType === "session" ? layer.sessions : layer.users;
		if (entry.kind === "black") target.black.add(entry.target);
		else target.white.add(entry.target);
	}

	return layer;
}
