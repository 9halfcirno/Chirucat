import sqlite from "better-sqlite3"
import { uuid } from "./utils/uuid";

export class UserManager {
	db: sqlite.Database;
	constructor(file: string) {
		this.db = new sqlite(file, {});
		this.db.pragma("foreign_keys = ON")
	}

	init() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS user_map (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				uuid TEXT NOT NULL,
				platform_name TEXT NOT NULL,
				platform_id TEXT NOT NULL,
				UNIQUE (platform_name, platform_id)
			)
		`)
	}

	/**
	 * 通过 platform id 查找 internal id, 若用户不存在则新建
	 * @param platform 平台
	 * @param id 平台用户 id
	 */
	get(platform: string, id: string): string {
		const getOrCreate = this.db.transaction((platformName: string, platformId: string) => {
			// 1. 先尝试直接查询
			const row = this.db.prepare(
				'SELECT uuid FROM user_map WHERE platform_name = ? AND platform_id = ?'
			).get(platformName, platformId) as { uuid: string } | undefined;

			if (row) {
				return row.uuid;
			}

			// 2. 查询不到，生成新的 uuid 并插入
			const newUuid = uuid();
			this.db.prepare(
				'INSERT OR IGNORE INTO user_map (uuid, platform_name, platform_id) VALUES (?, ?, ?)'
			).run(newUuid, platformName, platformId);

			// 3. 再次查询返回（防止并发冲突时 INSERT 被 IGNORE 导致没拿对 uuid）
			const result = this.db.prepare(
				'SELECT uuid FROM user_map WHERE platform_name = ? AND platform_id = ?'
			).get(platformName, platformId) as { uuid: string };

			return result.uuid;
		});

		return getOrCreate(platform, id);
	}

	/**
	 * 将一个平台的用户绑定到指定 internal id
	 * @param internalId 需要绑定的 internal id
	 * @param platform 平台
	 * @param id 平台用户 id
	 */
	bind(internalId: string, platform: string, id: string): void {
		this.db.prepare(`
            INSERT INTO user_map (uuid, platform_name, platform_id)
            VALUES (?, ?, ?)
            ON CONFLICT(platform_name, platform_id) 
            DO UPDATE SET uuid = excluded.uuid
        `).run(internalId, platform, id);
	}

	/**
	 * 将指定平台用户从指定 internal id 解绑
	 * @param internalId 需要解绑的 internal id
	 * @param platform 平台
	 * @param id 平台用户 id
	 */
	unbind(internalId: string, platform: string, id: string): boolean {
		const result = this.db.prepare(`
            DELETE FROM user_map 
            WHERE uuid = ? AND platform_name = ? AND platform_id = ?
        `).run(internalId, platform, id);

		// 返回是否成功解绑（changes > 0 说明成功删除了匹配的绑定记录）
		return result.changes > 0;
	}
}