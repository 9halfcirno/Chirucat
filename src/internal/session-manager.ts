import sqlite from "better-sqlite3"
import { v5 as uuidv5 } from "uuid";
import type { SessionType } from "../protocols/session";
import { StateError } from "../errors/state-error";

// 魔法, 作为 uuidv5 的种子, 后续不应再动
const CHIRUCAT_SESSION_NS = "f9bf60af-5f65-47fc-9de1-ab24a22292a1";
const CHIRUCAT_SESSION_UNION_NS = "6b1e4a2c-3d5f-4e8a-9c7b-1f2d3e4a5b6c";

export type SessionPlatformInfo = {
	/** 会话平台id */
	id: string;
	/** 平台名 */
	platform: string;
	/** 会话类型 */
	type: SessionType;
}

// 逻辑会话组成员
export type SessionLinkMember = SessionPlatformInfo & {
	/** 会话 UUID */
	sessionId: string;
}

export class SessionManager {
	db: sqlite.Database;

	// 预编译语句与事务包装: init() 建表后一次性编译(表不存在时 prepare 会直接抛错, 不能提前)
	#stmtSessionByKey!: sqlite.Statement<[string, SessionType, string], { uuid: string }>;
	#stmtInsertSession!: sqlite.Statement<[string, string, SessionType, string]>;
	#stmtExistsByKey!: sqlite.Statement<[string, SessionType, string], { is_exist: 0 | 1 }>;
	#stmtQuery!: sqlite.Statement<[string], { platform_id: string; platform_type: SessionType; platform_name: string }>;
	#stmtQueryMany!: sqlite.Statement<[string], { uuid: string; platform_id: string; platform_type: SessionType; platform_name: string }>;
	// 绑定相关语句
	#stmtSessionExists!: sqlite.Statement<[string]>;
	#stmtLinkInternal!: sqlite.Statement<[string], { internal_id: string }>;
	#stmtInsertLink!: sqlite.Statement<[string, string]>;
	#stmtBind!: sqlite.Statement<[string, string, string | null]>;
	#stmtUnbind!: sqlite.Statement<[string, string, string]>;
	#stmtLastInternal!: sqlite.Statement<[string], { last_internal_id: string | null }>;
	#stmtListMembers!: sqlite.Statement<[string], { sessionId: string; platform: string; type: SessionType; id: string }>;

	#txGet!: (platform: string, type: SessionType, id: string) => string;
	// 事务包装
	#txBind!: (internalId: string, sessionUuid: string) => boolean;
	#txUnbind!: (internalId: string, sessionUuid: string) => boolean;

	constructor(db: sqlite.Database) {
		this.db = db;
	}

	init() {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_map (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				uuid TEXT NOT NULL,
				platform_name TEXT NOT NULL,
				platform_type TEXT NOT NULL,
				platform_id TEXT NOT NULL,
				UNIQUE (platform_name, platform_type, platform_id)
			);

			-- uuid 作为"平台会话物理标识", 逻辑上应唯一; 若历史库存在脏数据这里会抛错, 需人工清理
			CREATE UNIQUE INDEX IF NOT EXISTS idx_session_map_uuid ON session_map(uuid);

			-- 会话绑定表: 记录每个会话所属的逻辑组
			CREATE TABLE IF NOT EXISTS session_link_map (
				uuid TEXT PRIMARY KEY,              -- 会话 UUID
				internal_id TEXT NOT NULL,          -- 逻辑会话组 ID
				last_internal_id TEXT,              -- 变更前的逻辑组 ID
				FOREIGN KEY (uuid) REFERENCES session_map(uuid) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_session_link_map_union ON session_link_map(internal_id);
		`)

		this.#prepare();
	}

	/** 编译全部语句与事务包装, 只在 init() 建表之后调用 */
	#prepare() {
		this.#stmtSessionByKey = this.db.prepare<[string, SessionType, string], { uuid: string }>(
			'SELECT uuid FROM session_map WHERE platform_name = ? AND platform_type = ? AND platform_id = ?'
		);
		this.#stmtInsertSession = this.db.prepare<[string, string, SessionType, string]>(
			'INSERT OR IGNORE INTO session_map (uuid, platform_name, platform_type, platform_id) VALUES (?, ?, ?, ?)'
		);
		this.#stmtExistsByKey = this.db.prepare<[string, SessionType, string], { is_exist: 0 | 1 }>(`
			SELECT EXISTS (SELECT 1 FROM session_map WHERE platform_name = ? AND platform_type = ? AND platform_id = ?) AS is_exist
		`);
		this.#stmtQuery = this.db.prepare<[string], { platform_id: string; platform_type: SessionType; platform_name: string }>(
			'SELECT platform_id, platform_type, platform_name FROM session_map WHERE uuid = ?'
		);
		// 变长 IN 列表: 走 json_each 保持单条固定语句, 不受参数个数影响
		this.#stmtQueryMany = this.db.prepare<[string], { uuid: string; platform_id: string; platform_type: SessionType; platform_name: string }>(`
			SELECT uuid, platform_id, platform_type, platform_name FROM session_map
			WHERE uuid IN (SELECT value FROM json_each(?))
		`);

		// 绑定相关语句
		this.#stmtSessionExists = this.db.prepare<[string]>(
			'SELECT 1 FROM session_map WHERE uuid = ?'
		);
		this.#stmtLinkInternal = this.db.prepare<[string], { internal_id: string }>(
			'SELECT internal_id FROM session_link_map WHERE uuid = ?'
		);
		this.#stmtInsertLink = this.db.prepare<[string, string]>(
			'INSERT OR IGNORE INTO session_link_map (uuid, internal_id) VALUES (?, ?)'
		);
		this.#stmtBind = this.db.prepare<[string, string, string | null]>(`
			INSERT INTO session_link_map (uuid, internal_id, last_internal_id)
			VALUES (?, ?, ?)
			ON CONFLICT(uuid) DO UPDATE SET
				internal_id = excluded.internal_id,
				last_internal_id = excluded.last_internal_id
		`);
		this.#stmtUnbind = this.db.prepare<[string, string, string]>(
			'UPDATE session_link_map SET internal_id = ?, last_internal_id = ? WHERE uuid = ?'
		);
		this.#stmtLastInternal = this.db.prepare<[string], { last_internal_id: string | null }>(
			'SELECT last_internal_id FROM session_link_map WHERE uuid = ?'
		);
		this.#stmtListMembers = this.db.prepare<[string], { sessionId: string; platform: string; type: SessionType; id: string }>(`
			SELECT s.uuid AS sessionId, s.platform_name AS platform, s.platform_type AS type, s.platform_id AS id
			FROM session_link_map m
			JOIN session_map s ON s.uuid = m.uuid
			WHERE m.internal_id = ?
			ORDER BY s.platform_name, s.platform_type, s.platform_id
		`);

		this.#txGet = this.db.transaction((platformName: string, sessionType: SessionType, platformId: string) => {
			// 1. 先尝试直接查询
			let sessionUuid: string;
			const row = this.#stmtSessionByKey.get(platformName, sessionType, platformId);

			if (row) {
				sessionUuid = row.uuid;
			} else {
				// 2. 查询不到，生成新的 uuid 并插入
				let key = [platformName.length, platformName, sessionType, platformId.length, platformId].join(":CHIRUCAT:");
				const newUuid = uuidv5(key, CHIRUCAT_SESSION_NS);
				this.#stmtInsertSession.run(newUuid, platformName, sessionType, platformId);
				// 3. 再次查询返回（防止并发冲突时 INSERT 被 IGNORE 导致没拿对 uuid）
				sessionUuid = this.#stmtSessionByKey.get(platformName, sessionType, platformId)!.uuid;
			}

			// 4. 确保该会话有默认逻辑组（独立成组）
			const linkRow = this.#stmtLinkInternal.get(sessionUuid);
			if (!linkRow) {
				const defaultInternalId = uuidv5(sessionUuid, CHIRUCAT_SESSION_UNION_NS);
				this.#stmtInsertLink.run(sessionUuid, defaultInternalId);
			}

			return sessionUuid;
		});

		// 绑定事务
		this.#txBind = this.db.transaction((internalId: string, sessionUuid: string) => {
			// 校验会话是否存在
			const physical = this.#stmtSessionExists.get(sessionUuid);
			if (!physical) {
				throw new Error(`bind: 会话 UUID "${sessionUuid}" 不存在于 session_map，无法绑定`);
			}

			// 变更前的组 ID 先记录, 供「回到上一个逻辑组」使用
			const current = this.#stmtLinkInternal.get(sessionUuid);

			// 已在该组时不算变更, 也不应覆盖历史记录
			if (current?.internal_id === internalId) return false;

			this.#stmtBind.run(sessionUuid, internalId, current?.internal_id ?? null);

			return true;
		});

		// 解绑事务
		this.#txUnbind = this.db.transaction((internalId: string, sessionUuid: string) => {
			const current = this.#stmtLinkInternal.get(sessionUuid);

			if (!current || current.internal_id !== internalId) {
				return false;
			}

			// 分配一个新的逻辑组 ID，实现解绑; 原组 ID 记入 last_internal_id 以便回退
			const newInternalId = uuidv5(sessionUuid, CHIRUCAT_SESSION_UNION_NS);
			const result = this.#stmtUnbind.run(newInternalId, current.internal_id, sessionUuid);

			return result.changes > 0;
		});
	}

	/**
	 * 通过 platform, type, id 查找 会话 internal id, 若会话不存在则新建
	 * @param platform 平台
	 * @param type 会话类型
	 * @param id 平台会话 id
	 */
	get(platform: string, type: SessionType, id: string): string {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		return this.#txGet(platform, type, id);
	}

	/**
	 * 纯查询: 根据平台, 类型与平台会话 ID 查找会话 UUID, 不产生任何写入。
	 * 与 get() 的区别是会话不存在时返回 null, 而不会创建会话记录。
	 * @returns 会话 UUID; 不存在则返回 null
	 */
	find(platform: string, type: SessionType, id: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const row = this.#stmtSessionByKey.get(platform, type, id);

		return row?.uuid ?? null;
	}

	has(platform: string, type: SessionType, id: string): boolean {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		return this.#stmtExistsByKey.get(platform, type, id)?.is_exist === 1;
	}

	/**
	 * 通过会话id查找该会话所有平台字段
	 * @param id 会话id
	 */
	query(id: string): SessionPlatformInfo | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const row = this.#stmtQuery.get(id);
		if (!row) return null;

		return {
			id: row.platform_id,
			type: row.platform_type,
			platform: row.platform_name,
		};
	}

	/** 批量查询多个会话的平台信息 */
	queryMany(ids: string[]): Map<string, SessionPlatformInfo> {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const result = new Map<string, SessionPlatformInfo>();
		if (ids.length === 0) return result;

		const rows = this.#stmtQueryMany.all(JSON.stringify(ids));

		for (const row of rows) {
			result.set(row.uuid, {
				id: row.platform_id,
				type: row.platform_type,
				platform: row.platform_name,
			});
		}

		return result;
	}

	/**
	 * 根据会话 UUID 查询其对应的逻辑会话组 ID。
	 * 若该会话尚无 link 记录，则会分配一个默认逻辑组 ID（独立成组）。
	 * @returns 逻辑组 ID; 会话不存在则返回 null
	 */
	getUnion(sessionId: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const exists = this.#stmtSessionExists.get(sessionId);
		if (!exists) return null;

		const row = this.#stmtLinkInternal.get(sessionId);
		if (row) return row.internal_id;

		const defaultInternalId = uuidv5(sessionId, CHIRUCAT_SESSION_UNION_NS);
		this.#stmtInsertLink.run(sessionId, defaultInternalId);

		// 再次查询返回（防止并发冲突时 INSERT 被 IGNORE 导致拿不到实际值）
		return this.#stmtLinkInternal.get(sessionId)!.internal_id;
	}

	/**
	 * 根据会话 UUID 查询其所属的逻辑会话组 ID, **纯查询**。
	 *
	 * 与 {@link getUnion} 的区别: 没有 link 记录时返回 `null`, 不会隐式创建。
	 * 用于消息实体这类高频路径 —— 会话由适配器经 `get()` 落库时已带默认组, 正常
	 * 情况下一次查询即命中。
	 * @returns 逻辑组 ID; 会话不存在或尚无 link 记录时为 null
	 */
	unionOf(sessionId: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const row = this.#stmtLinkInternal.get(sessionId);
		return row?.internal_id ?? null;
	}

	/**
	 * 将会话绑定到指定逻辑组。逻辑组不存在时隐式创建。
	 * @param internalId 逻辑组 ID
	 * @param sessionUuid 会话 UUID（必须已存在于 session_map）
	 * @returns 是否发生实际变更
	 */
	bind(internalId: string, sessionUuid: string): boolean {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		return this.#txBind(internalId, sessionUuid);
	}

	/**
	 * 将指定会话从指定逻辑组解绑，解绑后独立成组。
	 */
	unbind(internalId: string, sessionUuid: string): boolean {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		return this.#txUnbind(internalId, sessionUuid);
	}

	/**
	 * 查询会话上一次所在的逻辑组 ID。
	 */
	getLast(sessionId: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const row = this.#stmtLastInternal.get(sessionId);
		return row?.last_internal_id ?? null;
	}

	/**
	 * 将会话恢复到上一次所在的逻辑组。
	 */
	restore(sessionId: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const last = this.getLast(sessionId);
		if (!last) return null;

		// bind 会把"恢复前的组"再写入 last_internal_id, 因此可再次切回
		if (!this.bind(last, sessionId)) return null;

		return last;
	}

	/**
	 * 查询指定逻辑组下的全部会话。
	 */
	listMembers(internalId: string): SessionLinkMember[] {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const rows = this.#stmtListMembers.all(internalId);

		return rows.map(row => ({
			sessionId: row.sessionId,
			platform: row.platform,
			type: row.type,
			id: row.id,
		}));
	}
}