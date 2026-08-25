import sqlite from "better-sqlite3"
import { uuid } from "./utils/uuid";

export class SessionManager {
	db: sqlite.Database;
	constructor(file: string) {
		this.db = new sqlite(file, {});
		this.db.pragma("foreign_keys = ON")
	}

	init() {
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
	}

	/**
	 * 通过 platform, type, id 查找 会话 internal id, 若会话不存在则新建
	 * @param platform 平台
	 * @param type 会话类型
	 * @param id 平台会话 id
	 */
	get(platform: string, type: string, id: string): string {
		const getOrCreate = this.db.transaction((platformName: string, platformType: string, platformId: string) => {
			// 1. 先尝试直接查询
			const row = this.db.prepare(
				'SELECT uuid FROM session_map WHERE platform_name = ? AND platform_type = ? AND platform_id = ?'
			).get(platformName, platformType, platformId) as { uuid: string } | undefined;

			if (row) {
				return row.uuid;
			}

			// 2. 查询不到，生成新的 uuid 并插入
			const newUuid = uuid();
			this.db.prepare(
				'INSERT OR IGNORE INTO session_map (uuid, platform_name, platform_type, platform_id) VALUES (?, ?, ?, ?)'
			).run(newUuid, platformName, platformType, platformId);

			// 3. 再次查询返回（防止并发冲突时 INSERT 被 IGNORE 导致没拿对 uuid）
			const result = this.db.prepare(
				'SELECT uuid FROM session_map WHERE platform_name = ? AND platform_type = ? AND platform_id = ?'
			).get(platformName, platformType, platformId) as { uuid: string };

			return result.uuid;
		});

		return getOrCreate(platform, type, id);
	}
}