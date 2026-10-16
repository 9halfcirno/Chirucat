import sqlite from "better-sqlite3"
import { v5 as uuidv5 } from "uuid";
import type { SessionType } from "../protocols/session";
import { StateError } from "../errors/state-error";

const CHIRUCAT_SESSION_NS = "f9bf60af-5f65-47fc-9de1-ab24a22292a1";

export type SessionPlatformInfo = {
	/** 会话平台id */
	id: string;
	/** 平台名 */
	platform: string;
	/** 会话类型 */
	type: SessionType;
}

export class SessionManager {
	db: sqlite.Database;

	// 预编译语句与事务包装: init() 建表后一次性编译(表不存在时 prepare 会直接抛错, 不能提前)
	#stmtSessionByKey!: sqlite.Statement<[string, SessionType, string], { uuid: string }>;
	#stmtInsertSession!: sqlite.Statement<[string, string, SessionType, string]>;
	#stmtExistsByKey!: sqlite.Statement<[string, SessionType, string], { is_exist: 0 | 1 }>;
	#stmtQuery!: sqlite.Statement<[string], { platform_id: string; platform_type: SessionType; platform_name: string }>;
	#stmtQueryMany!: sqlite.Statement<[string], { uuid: string; platform_id: string; platform_type: SessionType; platform_name: string }>;
	#txGet!: (platform: string, type: SessionType, id: string) => string;

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
			)
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

		this.#txGet = this.db.transaction((platformName: string, sessionType: SessionType, platformId: string) => {
			// 1. 先尝试直接查询
			const row = this.#stmtSessionByKey.get(platformName, sessionType, platformId);

			if (row) {
				return row.uuid;
			}

			// 2. 查询不到，生成新的 uuid 并插入
			let key = [platformName.length, platformName, sessionType, platformId.length, platformId].join(":CHIRUCAT:");
			const newUuid = uuidv5(key, CHIRUCAT_SESSION_NS);
			this.#stmtInsertSession.run(newUuid, platformName, sessionType, platformId);

			// 3. 再次查询返回（防止并发冲突时 INSERT 被 IGNORE 导致没拿对 uuid）
			const result = this.#stmtSessionByKey.get(platformName, sessionType, platformId)!;

			return result.uuid;
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

	has(platform: string, type: SessionType, id: string) {
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
		if (!row) {
			return null;
		}
		return {
			id: row.platform_id,
			type: row.platform_type,
			platform: row.platform_name
		}
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
}