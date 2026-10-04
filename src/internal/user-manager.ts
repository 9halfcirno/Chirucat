import sqlite from "better-sqlite3";
import { v5 as uuidv5 } from "uuid";
import { StateError } from "../errors/state-error";

// 魔法, 作为uuidv5的种子, 后续不应再动
const CHIRUCAT_ACCOUNT_NS = "158971f7-750a-42fa-8f02-6776b3d4d377";
const CHIRUCAT_UNION_NS = "7dbcc57a-7c27-44f1-8d33-e531ce50be86";

export type UserPlatformInfo = {
	/** 用户平台id */
	id: string;
	/** 平台名 */
	platform: string;
}

export type UnionMember = UserPlatformInfo & {
	/** 账号 UUID */
	accountId: string;
}

export type UserListItem = UserPlatformInfo & {
	/** 账号 UUID */
	accountId: string;
	/** 所属跨平台ID */
	unionId: string;
	/** 该跨平台ID下的账号数 */
	unionSize: number;
}

export type UserListQuery = {
	/** 平台筛选, 缺省为全部 */
	platform?: string;
	/** 关键字: 匹配平台用户ID 或 账号 UUID */
	keyword?: string;
	/** 绑定状态: all=全部, bound=组内多于一个, single=独立成组 */
	bound?: "all" | "bound" | "single";
	/** 每页条数 */
	limit: number;
	/** 偏移量 */
	offset: number;
}

export type UserOverview = {
	/** 账号总数 */
	accounts: number;
	/** 跨平台ID 总数 */
	unions: number;
	/** 已绑定的跨平台ID 数 (组内多于一个账号) */
	boundUnions: number;
	/** 独立成组的账号数 (组内只有自己) */
	singleAccounts: number;
	/** 各平台账号数 */
	platforms: { platform: string; accounts: number }[];
}

export class UserManager {
	db: sqlite.Database;

	constructor(db: sqlite.Database) {
		this.db = db;
	}

	init() {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);
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
                last_internal_id TEXT,              -- 变更前的内部组 ID, 用于回到上一个跨平台ID
                FOREIGN KEY (uuid) REFERENCES account_map(uuid) ON DELETE CASCADE
            );

            -- 按组查成员（组内成员列表 / 组内计数）
            CREATE INDEX IF NOT EXISTS idx_internal_map_union ON internal_map(internal_id);
        `);

		// 老库补列: CREATE TABLE IF NOT EXISTS 不会为已存在的表新增列
		if (!this.#hasColumn("internal_map", "last_internal_id")) {
			this.db.exec(`ALTER TABLE internal_map ADD COLUMN last_internal_id TEXT`);
		}
	}

	/** 表是否已包含某列 */
	#hasColumn(table: string, column: string): boolean {
		const rows = this.db.pragma(`table_info(${table})`) as { name: string }[];
		return rows.some(row => row.name === column);
	}

	/**
	 * 根据平台和平台用户 ID 获取对应的账号 UUID（若不存在则新建）
	 * 新建账号时会自动分配一个初始的内部组 ID（即该账号独立成组）
	 * @param platform 平台名称
	 * @param id 平台用户 ID
	 * @returns 账号 UUID
	 */
	get(platform: string, id: string): string {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);
		const getOrCreate = this.db.transaction((platformName: string, platformId: string) => {
			// 1. 查找账号 UUID
			let mapRow = this.db.prepare(
				'SELECT uuid FROM account_map WHERE platform_name = ? AND platform_id = ?'
			).get(platformName, platformId) as { uuid: string } | undefined;

			if (!mapRow) {
				// 不存在则创建账号 UUID，多进程环境下使用 OR IGNORE 容错
				let key = [platformName.length, platformName, platformId.length, platformId].join(":CHIRUCAT:");
				const newUuid = uuidv5(key, CHIRUCAT_ACCOUNT_NS);
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
				const newInternalId = uuidv5(mapRow.uuid, CHIRUCAT_UNION_NS);
				this.db.prepare(
					'INSERT OR IGNORE INTO internal_map (uuid, internal_id) VALUES (?, ?)'
				).run(mapRow.uuid, newInternalId);
			}

			return mapRow.uuid;
		});

		return getOrCreate(platform, id);
	}

	has(platform: string, id: string) {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		let has = this.db.transaction((p: string, id: string) => {
			let res = this.db.prepare(`
				SELECT EXISTS (SELECT 1 FROM account_map WHERE platform_name = ? AND platform_id = ?) AS is_exist
			`).get(p, id) as { is_exist: boolean } | undefined;

			if (!res?.is_exist) return false;
			return true;
		})

		return has(platform, id)
	}

	/**
	 * 将一个账号（通过账号 UUID 指定）绑定到指定的内部组 ID。
	 * 如果该内部组 ID 尚未出现，则操作会此隐式创建该组。
	 * @param internalId 内部组 ID（逻辑分组标识）
	 * @param accountUuid 账号 UUID（必须已存在于 account_map）
	 */
	bind(internalId: string, accountUuid: string): boolean {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		return this.db.transaction(() => {
			// 校验账号是否存在
			const physical = this.db.prepare(
				'SELECT 1 FROM account_map WHERE uuid = ?'
			).get(accountUuid);
			if (!physical) {
				throw new Error(`bind: 账号 UUID "${accountUuid}" 不存在于 account_map，无法绑定`);
			}

			// 变更前的组 ID 先记录, 供「回到上一个跨平台ID」使用
			const current = this.db.prepare(
				'SELECT internal_id FROM internal_map WHERE uuid = ?'
			).get(accountUuid) as { internal_id: string } | undefined;

			// 已在该组时不算变更, 也不应覆盖历史记录
			if (current?.internal_id === internalId) return false;

			// 插入或更新 internal_map，将账号 UUID 关联到指定的内部组 ID
			this.db.prepare(`
				INSERT INTO internal_map (uuid, internal_id, last_internal_id)
				VALUES (?, ?, ?)
				ON CONFLICT(uuid) DO UPDATE SET
					internal_id = excluded.internal_id,
					last_internal_id = excluded.last_internal_id
			`).run(accountUuid, internalId, current?.internal_id ?? null);

			return true;
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
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		return this.db.transaction(() => {
			// 检查该账号当前所属的内部组 ID 是否匹配
			const current = this.db.prepare(
				'SELECT internal_id FROM internal_map WHERE uuid = ?'
			).get(accountUuid) as { internal_id: string } | undefined;

			if (!current || current.internal_id !== internalId) {
				return false;
			}

			// 分配一个新的内部组 ID，实现解绑; 原组 ID 记入 last_internal_id 以便回退
			const newInternalId = uuidv5(accountUuid, CHIRUCAT_UNION_NS);
			const result = this.db.prepare(
				'UPDATE internal_map SET internal_id = ?, last_internal_id = ? WHERE uuid = ?'
			).run(newInternalId, current.internal_id, accountUuid);

			return result.changes > 0;
		})();
	}

	/**
	 * 根据账号 UUID 查询其对应的平台名称和平台用户 ID
	 * @param accountUuid 账号 UUID
	 * @returns 平台信息，若不存在则返回 null
	 */
	query(accountUuid: string): UserPlatformInfo | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

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
	 * 批量查询多个账号的平台信息
	 * @param accountIds 账号 UUID 列表
	 */
	queryMany(accountIds: string[]): Map<string, UserPlatformInfo> {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const result = new Map<string, UserPlatformInfo>();
		if (accountIds.length === 0) return result;

		const placeholders = accountIds.map(() => "?").join(", ");
		const rows = this.db.prepare(`
			SELECT uuid, platform_name, platform_id FROM account_map WHERE uuid IN (${placeholders})
		`).all(...accountIds) as { uuid: string; platform_name: string; platform_id: string }[];

		for (const row of rows) {
			result.set(row.uuid, { platform: row.platform_name, id: row.platform_id });
		}

		return result;
	}

	/**
	 * 根据账号 ID（账号 UUID）查询其对应的内部组 ID（internal id）。
	 * 若该账号在 internal_map 中尚无记录，则会为其分配一个新的内部组 ID 作为默认值（即独立成组）。
	 * @param accountId 账号 ID（账号 UUID，即 get() 的返回值）
	 * @returns 内部组 ID（internal id）；若账号不存在则返回 null
	 */
	getUnion(accountId: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

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
		const defaultInternalId = uuidv5(accountId, CHIRUCAT_UNION_NS);
		this.db.prepare(
			'INSERT OR IGNORE INTO internal_map (uuid, internal_id) VALUES (?, ?)'
		).run(accountId, defaultInternalId);

		// 再次查询返回（防止并发冲突时 INSERT 被 IGNORE 导致拿不到实际值）
		const result = this.db.prepare(
			'SELECT internal_id FROM internal_map WHERE uuid = ?'
		).get(accountId) as { internal_id: string };

		return result.internal_id;
	}

	/**
	 * 纯查询: 根据平台和平台用户 ID 获取账号 UUID, 不产生任何写入。
	 * 与 get() 的区别是账号不存在时返回 null, 而不会创建账号与内部组记录。
	 * @returns 账号 UUID; 不存在则返回 null
	 */
	find(platform: string, id: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const row = this.db.prepare(
			'SELECT uuid FROM account_map WHERE platform_name = ? AND platform_id = ?'
		).get(platform, id) as { uuid: string } | undefined;

		return row?.uuid ?? null;
	}

	/**
	 * 查询指定内部组下的全部账号
	 * @param internalId 内部组 ID（跨平台ID）
	 */
	listMembers(internalId: string): UnionMember[] {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const rows = this.db.prepare(`
			SELECT m.uuid AS accountId, a.platform_name AS platform, a.platform_id AS id
			FROM internal_map m
			JOIN account_map a ON a.uuid = m.uuid
			WHERE m.internal_id = ?
			ORDER BY a.platform_name, a.platform_id
		`).all(internalId) as { accountId: string; platform: string; id: string }[];

		return rows.map(row => ({ accountId: row.accountId, platform: row.platform, id: row.id }));
	}

	/**
	 * 查询账号上一次所在的内部组 ID（任何一次变更前记录的值）
	 * @returns 内部组 ID; 无记录（新账号或从未变更）返回 null
	 */
	getLast(accountId: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const row = this.db.prepare(
			'SELECT last_internal_id FROM internal_map WHERE uuid = ?'
		).get(accountId) as { last_internal_id: string | null } | undefined;

		return row?.last_internal_id ?? null;
	}

	/**
	 * 将账号恢复到上一次所在的内部组。
	 * 目标组若已无其他成员, 恢复后该账号将独占该组 ——
	 * 组由成员定义, 框架不存在显式建组, 因此这里不做组的存在性校验。
	 * @param accountId 账号 UUID
	 * @returns 恢复后的内部组 ID; 账号不存在或没有历史记录时返回 null
	 */
	restore(accountId: string): string | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const last = this.getLast(accountId);
		if (!last) return null;

		// bind 会把“恢复前的组”再写入 last_internal_id, 因此可再次切回
		if (!this.bind(last, accountId)) return null;

		return last;
	}

	/**
	 * 分页查询账号列表。
	 *
	 * 排序固定为 平台 -> 平台用户ID, 保证翻页结果稳定。活跃度等派生指标
	 * 不在本库, 由调用方拿到本页账号后另外查询 (统计库与内部库是两个文件, 无法联表)。
	 */
	list(query: UserListQuery): { items: UserListItem[]; total: number } {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const params: (string | number)[] = [];
		let condition = "1 = 1";

		if (query.platform) {
			condition += " AND a.platform_name = ?";
			params.push(query.platform);
		}
		if (query.keyword) {
			condition += " AND (a.platform_id LIKE ? OR a.uuid LIKE ?)";
			const like = `%${query.keyword}%`;
			params.push(like, like);
		}
		if (query.bound === "bound") condition += " AND s.size > 1";
		else if (query.bound === "single") condition += " AND s.size = 1";

		const from = `
			FROM account_map a
			JOIN internal_map m ON m.uuid = a.uuid
			JOIN (SELECT internal_id, COUNT(*) AS size FROM internal_map GROUP BY internal_id) s
				ON s.internal_id = m.internal_id
			WHERE ${condition}
		`;

		const total = (this.db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params) as { c: number }).c;

		const rows = this.db.prepare(`
			SELECT a.uuid AS accountId, a.platform_name AS platform, a.platform_id AS id,
			       m.internal_id AS unionId, s.size AS unionSize
			${from}
			ORDER BY a.platform_name, a.platform_id
			LIMIT ? OFFSET ?
		`).all(...params, query.limit, query.offset) as {
			accountId: string; platform: string; id: string; unionId: string; unionSize: number;
		}[];

		return {
			items: rows.map(row => ({
				accountId: row.accountId,
				platform: row.platform,
				id: row.id,
				unionId: row.unionId,
				unionSize: row.unionSize,
			})),
			total,
		};
	}

	/** 概览: 账号与跨平台ID 的规模统计 */
	overview(): UserOverview {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const count = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c;

		const platforms = this.db.prepare(`
			SELECT platform_name AS platform, COUNT(*) AS accounts
			FROM account_map GROUP BY platform_name ORDER BY accounts DESC
		`).all() as { platform: string; accounts: number }[];

		return {
			accounts: count('SELECT COUNT(*) AS c FROM account_map'),
			unions: count('SELECT COUNT(*) AS c FROM (SELECT internal_id FROM internal_map GROUP BY internal_id)'),
			boundUnions: count('SELECT COUNT(*) AS c FROM (SELECT internal_id FROM internal_map GROUP BY internal_id HAVING COUNT(*) > 1)'),
			singleAccounts: count(`
				SELECT COUNT(*) AS c FROM internal_map m
				JOIN (SELECT internal_id FROM internal_map GROUP BY internal_id HAVING COUNT(*) = 1) s
					ON s.internal_id = m.internal_id
			`),
			platforms,
		};
	}
}