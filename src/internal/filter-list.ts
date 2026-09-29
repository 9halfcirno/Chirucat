import sqlite from "better-sqlite3";
import { StateError } from "../errors/state-error";

export type FilterScope = "global" | "bot";
export type FilterKind = "black" | "white";
/** 名单对象: 用户(账号) 或 会话(群/频道) */
export type FilterTargetType = "user" | "session";

export type FilterEntry = {
	id: number;
	scope: FilterScope;
	/** scope=bot 时所属的 Bot id; 全局名单为空串 */
	botId: string;
	kind: FilterKind;
	targetType: FilterTargetType;
	/** 被列入名单的账号 UUID 或会话 UUID */
	target: string;
	reason: string;
	createdAt: number;
}

/** 一类对象的可判定集合 */
export type FilterSets = {
	black: Set<string>;
	white: Set<string>;
}

/** 一层名单: 用户与会话各自独立 */
export type LayerSets = {
	users: FilterSets;
	sessions: FilterSets;
}

/** 某个 Bot 实际生效的两层名单 */
export type FilterLayers = {
	global: LayerSets;
	bot: LayerSets;
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
 * 消息过滤名单
 *
 * 名单对象有两类:
 * - user:    账号 (account UUID), 与 MessageFilter 的 by: "sender" 对应
 * - session: 会话 (session UUID), 与 by: "session" 对应, 用于群 / 频道
 *            私聊会话与用户一一对应, 因此不单独支持, 由用户名单覆盖
 *
 * 范围分两级 (global / bot), 两级在判定时都要放行 —— 详见 MessageHandler。
 *
 * @deprecated 过滤能力将抽离为独立服务插件(services/filter): 名单存储、判定与
 *   WebUI 入口届时一并迁移, `Core.filterList` 也会移除。过渡期只做修复性改动,
 *   新代码不要再依赖本模块。
 */
export class FilterListManager {
	db: sqlite.Database;

	constructor(db: sqlite.Database) {
		this.db = db;
	}

	init() {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);
		this.db.exec(CREATE_TABLE);
		this.db.exec(CREATE_INDEX);
		this.#migrate();
	}

	/** 表是否已包含某列 */
	#hasColumn(table: string, column: string): boolean {
		const rows = this.db.pragma(`table_info(${table})`) as { name: string }[];
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

		this.db.transaction(() => {
			this.db.exec(`ALTER TABLE filter_list RENAME TO filter_list_legacy`);
			this.db.exec(CREATE_TABLE);
			this.db.exec(`
				INSERT INTO filter_list (id, scope, bot_id, kind, target_type, target, reason, created_at)
				SELECT id, scope, bot_id, kind, 'user', target, reason, created_at FROM filter_list_legacy
			`);
			this.db.exec(`DROP TABLE filter_list_legacy`);
			// 旧索引随表被重命名后一并丢弃, 这里为新表重建
			this.db.exec(CREATE_INDEX);
		})();
	}

	/** 列出某个范围的名单; 可按对象类型筛选 */
	list(scope: FilterScope, botId = "", targetType?: FilterTargetType): FilterEntry[] {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const params: string[] = [];
		let where = scope === "global"
			? `scope = 'global'`
			: `scope = 'bot' AND bot_id = ?`;
		if (scope === "bot") params.push(botId);
		if (targetType) {
			where += " AND target_type = ?";
			params.push(targetType);
		}

		const rows = this.db.prepare(`SELECT * FROM filter_list WHERE ${where} ORDER BY target_type, kind, id`).all(...params);
		return (rows as RawEntry[]).map(toEntry);
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
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const scopedBotId = scope === "bot" ? botId : "";
		this.db.prepare(`
			INSERT INTO filter_list (scope, bot_id, kind, target_type, target, reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(scope, bot_id, kind, target_type, target) DO UPDATE SET reason = excluded.reason
		`).run(scope, scopedBotId, kind, targetType, target, reason, Date.now());

		const row = this.db.prepare(`
			SELECT * FROM filter_list
			WHERE scope = ? AND bot_id = ? AND kind = ? AND target_type = ? AND target = ?
		`).get(scope, scopedBotId, kind, targetType, target) as RawEntry;

		return toEntry(row);
	}

	/**
	 * 按 id 删除一项
	 * @returns 被删除的条目 (调用方据此决定要刷新哪些 Bot); 不存在时返回 null
	 */
	remove(id: number): FilterEntry | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		return this.db.transaction(() => {
			const row = this.db.prepare('SELECT * FROM filter_list WHERE id = ?').get(id) as RawEntry | undefined;
			if (!row) return null;

			this.db.prepare('DELETE FROM filter_list WHERE id = ?').run(id);
			return toEntry(row);
		})();
	}

	/** 删除某个 Bot 的全部私有名单 (Bot 被删除时调用), 返回删除条数 */
	removeByBot(botId: string): number {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);
		return this.db.prepare(`DELETE FROM filter_list WHERE scope = 'bot' AND bot_id = ?`).run(botId).changes;
	}

	/** 装载某个 Bot 生效的两层名单 */
	loadFor(botId: string): FilterLayers {
		return {
			global: toLayerSets(this.list("global")),
			bot: toLayerSets(this.list("bot", botId)),
		};
	}
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

/** 把条目按对象类型分到用户/会话两组集合 */
function toLayerSets(entries: FilterEntry[]): LayerSets {
	const sets: LayerSets = {
		users: { black: new Set(), white: new Set() },
		sessions: { black: new Set(), white: new Set() },
	};

	for (const entry of entries) {
		const target = entry.targetType === "session" ? sets.sessions : sets.users;
		if (entry.kind === "black") target.black.add(entry.target);
		else target.white.add(entry.target);
	}

	return sets;
}
