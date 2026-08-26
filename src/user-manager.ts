import sqlite from "better-sqlite3";
import { uuid } from "./utils/uuid";

export type UserPlatformInfo = {
	/** 用户平台id */
	id: string;
	/** 平台名 */
	platform: string;

}

export class UserManager {
	db: sqlite.Database;

	constructor(file: string) {
		this.db = new sqlite(file, {});
		this.db.pragma("foreign_keys = ON");
	}

	init() {
		this.db.exec(`
            -- 1. 物理映射表：平台账号 1:1 绝对映射物理 uuid
            CREATE TABLE IF NOT EXISTS user_map (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT NOT NULL UNIQUE,
                platform_name TEXT NOT NULL,
                platform_id TEXT NOT NULL,
                UNIQUE (platform_name, platform_id)
            );

            -- 2. 逻辑关联表：记录逻辑 internal_id 到物理 uuid 的映射关系
            CREATE TABLE IF NOT EXISTS user_link (
                uuid TEXT PRIMARY KEY,
                internal_id TEXT NOT NULL,
                FOREIGN KEY (uuid) REFERENCES user_map(uuid) ON DELETE CASCADE
            );
        `);
	}

	/**
	 * 通过 platform id 查找物理 internal id (uuid)，若用户不存在则新建
	 * @param platform 平台
	 * @param id 平台用户 id
	 * @returns 返回物理 uuid
	 */
	get(platform: string, id: string): string {
		const getOrCreate = this.db.transaction((platformName: string, platformId: string) => {
			// 1. 查找物理 uuid
			let mapRow = this.db.prepare(
				'SELECT uuid FROM user_map WHERE platform_name = ? AND platform_id = ?'
			).get(platformName, platformId) as { uuid: string } | undefined;

			if (!mapRow) {
				// 不存在则创建物理 uuid。多进程共享同一 db 文件时，
				// SELECT 与 INSERT 之间可能已被其他进程抢先插入，
				// 用 OR IGNORE 容错并重新查询拿到实际行（含并发进程插入的行）
				const newUuid = uuid();
				this.db.prepare(
					'INSERT OR IGNORE INTO user_map (uuid, platform_name, platform_id) VALUES (?, ?, ?)'
				).run(newUuid, platformName, platformId);

				mapRow = this.db.prepare(
					'SELECT uuid FROM user_map WHERE platform_name = ? AND platform_id = ?'
				).get(platformName, platformId) as { uuid: string };
			}

			// 2. 检查底层 user_link 关系是否存在，不存在则分配一个新的 internal_id
			const linkRow = this.db.prepare(
				'SELECT internal_id FROM user_link WHERE uuid = ?'
			).get(mapRow.uuid) as { internal_id: string } | undefined;

			if (!linkRow) {
				// 并发下同一物理 uuid 的 link 行可能已被抢先插入，用 OR IGNORE 容错
				const newInternalId = uuid();
				this.db.prepare(
					'INSERT OR IGNORE INTO user_link (uuid, internal_id) VALUES (?, ?)'
				).run(mapRow.uuid, newInternalId);
			}

			// 上层 API 依然返回 user_map 的物理 uuid
			return mapRow.uuid;
		});

		return getOrCreate(platform, id);
	}

	/**
	 * 将一个平台的用户绑定到指定的物理 internal id
	 * 逻辑：先获取目标物理 uuid 对应的逻辑 internal_id，然后在 user_link 中添加/更新一条 (物理 uuid -> 逻辑 internal_id) 的关联
	 * @param internalId 目标的物理 internal id
	 * @param platform 平台
	 * @param id 平台用户 id
	 */
	bind(internalId: string, platform: string, id: string): void {
		this.db.transaction(() => {
			// 1. 获取目标物理 internalId 对应的底层逻辑 internal_id
			let targetLink = this.db.prepare(
				'SELECT internal_id FROM user_link WHERE uuid = ?'
			).get(internalId) as { internal_id: string } | undefined;

			// 如果目标物理 id 在 link 表里没有记载，初始化一个逻辑 id 给它
			let targetInternalId = targetLink?.internal_id;
			if (!targetInternalId) {
				// bind 要求 internalId 是已存在的物理 uuid（通常来自 get()）。
				// 若它不在 user_map 中，插入 user_link 会触发外键错误
				// （INSERT OR IGNORE 无法抑制外键违规），这里先校验并给出清晰报错
				const physical = this.db.prepare(
					'SELECT 1 FROM user_map WHERE uuid = ?'
				).get(internalId);
				if (!physical) {
					throw new Error(`bind: 物理 uuid "${internalId}" 不存在于 user_map，无法绑定`);
				}

				targetInternalId = uuid();
				this.db.prepare(
					'INSERT OR IGNORE INTO user_link (uuid, internal_id) VALUES (?, ?)'
				).run(internalId, targetInternalId);
			}

			// 2. 确保被绑定的平台用户在 user_map 中有物理记录
			let targetMap = this.db.prepare(
				'SELECT uuid FROM user_map WHERE platform_name = ? AND platform_id = ?'
			).get(platform, id) as { uuid: string } | undefined;

			if (!targetMap) {
				// 并发下可能已被其他进程抢先插入，用 OR IGNORE 容错并重新查询
				const newUuid = uuid();
				this.db.prepare(
					'INSERT OR IGNORE INTO user_map (uuid, platform_name, platform_id) VALUES (?, ?, ?)'
				).run(newUuid, platform, id);
				targetMap = this.db.prepare(
					'SELECT uuid FROM user_map WHERE platform_name = ? AND platform_id = ?'
				).get(platform, id) as { uuid: string };
			}

			// 3. 将新/被绑定的物理 uuid 关联到相同的逻辑 internal_id 下
			this.db.prepare(`
                INSERT INTO user_link (uuid, internal_id)
                VALUES (?, ?)
                ON CONFLICT(uuid) 
                DO UPDATE SET internal_id = excluded.internal_id
            `).run(targetMap.uuid, targetInternalId);
		})();
	}

	/**
	 * 将指定平台用户从指定的物理 internal id 解绑
	 * @param internalId 当前绑定的物理 internal id
	 * @param platform 平台
	 * @param id 平台用户 id
	 */
	unbind(internalId: string, platform: string, id: string): boolean {
		return this.db.transaction(() => {
			// 1. 查找目标物理账号的物理 uuid
			const targetMap = this.db.prepare(
				'SELECT uuid FROM user_map WHERE platform_name = ? AND platform_id = ?'
			).get(platform, id) as { uuid: string } | undefined;

			if (!targetMap) return false;

			// 2. 查找传入的物理 internalId 所属的逻辑 internal_id
			const currentLink = this.db.prepare(
				'SELECT internal_id FROM user_link WHERE uuid = ?'
			).get(internalId) as { internal_id: string } | undefined;

			if (!currentLink) return false;

			// 3. 将被解绑的物理 uuid 重新分配一个新的逻辑 internal_id（相当于切断与原逻辑组的关联）
			const result = this.db.prepare(
				'UPDATE user_link SET internal_id = ? WHERE uuid = ? AND internal_id = ?'
			).run(uuid(), targetMap.uuid, currentLink.internal_id);

			return result.changes > 0;
		})();
	}

	/**
	 * 通过物理 uuid 获取其对应的平台名称和平台用户 id
	 * @param targetUuid 物理 uuid
	 */
	query(targetUuid: string): UserPlatformInfo | null {
		const row = this.db.prepare(
			'SELECT platform_name, platform_id FROM user_map WHERE uuid = ?'
		).get(targetUuid) as { platform_name: string; platform_id: string } | undefined;

		if (!row) return null;

		return {
			platform: row.platform_name,
			id: row.platform_id
		};
	}
}