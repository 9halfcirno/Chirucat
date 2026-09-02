import sqlite from "better-sqlite3";
import { uuid } from "../utils/uuid";

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
            -- 1. 账号映射表：存储平台账号的唯一标识（账号 UUID）
            CREATE TABLE IF NOT EXISTS account_map (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT NOT NULL UNIQUE,          -- 账号 UUID（物理唯一标识）
                platform_name TEXT NOT NULL,
                platform_id TEXT NOT NULL,
                UNIQUE (platform_name, platform_id)
            );

            -- 2. 内部组映射表：记录账号 UUID 所属的逻辑组（内部组 ID）
            CREATE TABLE IF NOT EXISTS internal_map (
                uuid TEXT PRIMARY KEY,              -- 账号 UUID
                internal_id TEXT NOT NULL,          -- 内部组 ID（逻辑分组标识）
                FOREIGN KEY (uuid) REFERENCES account_map(uuid) ON DELETE CASCADE
            );
        `);
	}

	/**
	 * 根据平台和平台用户 ID 获取对应的账号 UUID（若不存在则新建）
	 * 新建账号时会自动分配一个初始的内部组 ID（即该账号独立成组）
	 * @param platform 平台名称
	 * @param id 平台用户 ID
	 * @returns 账号 UUID
	 */
	get(platform: string, id: string): string {
		const getOrCreate = this.db.transaction((platformName: string, platformId: string) => {
			// 1. 查找账号 UUID
			let mapRow = this.db.prepare(
				'SELECT uuid FROM account_map WHERE platform_name = ? AND platform_id = ?'
			).get(platformName, platformId) as { uuid: string } | undefined;

			if (!mapRow) {
				// 不存在则创建账号 UUID，多进程环境下使用 OR IGNORE 容错
				const newUuid = uuid();
				this.db.prepare(
					'INSERT OR IGNORE INTO account_map (uuid, platform_name, platform_id) VALUES (?, ?, ?)'
				).run(newUuid, platformName, platformId);

				mapRow = this.db.prepare(
					'SELECT uuid FROM account_map WHERE platform_name = ? AND platform_id = ?'
				).get(platformName, platformId) as { uuid: string };
			}

			// 2. 检查该账号是否已有内部组 ID，若没有则分配一个新的
			const linkRow = this.db.prepare(
				'SELECT internal_id FROM internal_map WHERE uuid = ?'
			).get(mapRow.uuid) as { internal_id: string } | undefined;

			if (!linkRow) {
				const newInternalId = uuid();
				this.db.prepare(
					'INSERT OR IGNORE INTO internal_map (uuid, internal_id) VALUES (?, ?)'
				).run(mapRow.uuid, newInternalId);
			}

			return mapRow.uuid;
		});

		return getOrCreate(platform, id);
	}

	/**
	 * 将一个账号（通过账号 UUID 指定）绑定到指定的内部组 ID。
	 * 如果该内部组 ID 尚未出现，则操作会此隐式创建该组。
	 * @param internalId 内部组 ID（逻辑分组标识）
	 * @param accountUuid 账号 UUID（必须已存在于 account_map）
	 */
	bind(internalId: string, accountUuid: string): void {
		this.db.transaction(() => {
			// 校验账号是否存在
			const physical = this.db.prepare(
				'SELECT 1 FROM account_map WHERE uuid = ?'
			).get(accountUuid);
			if (!physical) {
				throw new Error(`bind: 账号 UUID "${accountUuid}" 不存在于 account_map，无法绑定`);
			}

			// 插入或更新 internal_map，将账号 UUID 关联到指定的内部组 ID
			this.db.prepare(`
				INSERT INTO internal_map (uuid, internal_id)
				VALUES (?, ?)
				ON CONFLICT(uuid) DO UPDATE SET internal_id = excluded.internal_id
			`).run(accountUuid, internalId);
		})();
	}

	/**
	 * 将指定账号从指定的内部组中解绑。
	 * 解绑后，该账号将获得一个全新的内部组 ID（即脱离原组，独立成组）。
	 * @param internalId 当前所在的内部组 ID
	 * @param accountUuid 账号 UUID
	 * @returns 是否成功解绑（若账号不存在或当前内部组 ID 不匹配则返回 false）
	 */
	unbind(internalId: string, accountUuid: string): boolean {
		return this.db.transaction(() => {
			// 检查该账号当前所属的内部组 ID 是否匹配
			const current = this.db.prepare(
				'SELECT internal_id FROM internal_map WHERE uuid = ?'
			).get(accountUuid) as { internal_id: string } | undefined;

			if (!current || current.internal_id !== internalId) {
				return false;
			}

			// 分配一个新的内部组 ID，实现解绑
			const newInternalId = uuid();
			const result = this.db.prepare(
				'UPDATE internal_map SET internal_id = ? WHERE uuid = ?'
			).run(newInternalId, accountUuid);

			return result.changes > 0;
		})();
	}

	/**
	 * 根据账号 UUID 查询其对应的平台名称和平台用户 ID
	 * @param accountUuid 账号 UUID
	 * @returns 平台信息，若不存在则返回 null
	 */
	query(accountUuid: string): UserPlatformInfo | null {
		const row = this.db.prepare(
			'SELECT platform_name, platform_id FROM account_map WHERE uuid = ?'
		).get(accountUuid) as { platform_name: string; platform_id: string } | undefined;

		if (!row) return null;

		return {
			platform: row.platform_name,
			id: row.platform_id
		};
	}

	/**
	 * 根据账号 ID（账号 UUID）查询其对应的内部组 ID（internal id）。
	 * 若该账号在 internal_map 中尚无记录，则会为其分配一个新的内部组 ID 作为默认值（即独立成组）。
	 * @param accountId 账号 ID（账号 UUID，即 get() 的返回值）
	 * @returns 内部组 ID（internal id）；若账号不存在则返回 null
	 */
	getUnion(accountId: string): string | null {
		// 账号不存在则返回默认值 null（避免向 internal_map 写入孤立记录触发外键约束报错）
		const exists = this.db.prepare(
			'SELECT 1 FROM account_map WHERE uuid = ?'
		).get(accountId);
		if (!exists) return null;

		// 查询账号当前的内部组 ID
		const row = this.db.prepare(
			'SELECT internal_id FROM internal_map WHERE uuid = ?'
		).get(accountId) as { internal_id: string } | undefined;
		if (row) return row.internal_id;

		// 账号尚无内部组 ID，分配一个新的内部组 ID 作为默认值
		const defaultInternalId = uuid();
		this.db.prepare(
			'INSERT OR IGNORE INTO internal_map (uuid, internal_id) VALUES (?, ?)'
		).run(accountId, defaultInternalId);

		// 再次查询返回（防止并发冲突时 INSERT 被 IGNORE 导致拿不到实际值）
		const result = this.db.prepare(
			'SELECT internal_id FROM internal_map WHERE uuid = ?'
		).get(accountId) as { internal_id: string };

		return result.internal_id;
	}
}