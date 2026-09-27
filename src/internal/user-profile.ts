import sqlite from "better-sqlite3";
import { StateError } from "../errors/state-error";

export type UserProfile = {
	/** 账号 UUID */
	accountId: string;
	/** 昵称 */
	name: string;
	/** 头像 URL; 框架暂无采集来源, 保留给未来的适配器能力 */
	avatar: string;
	/** 最近一次更新时间(ms) */
	updatedAt: number;
}

/**
 * 用户档案
 *
 * 只存放"展示用"的信息(昵称、头像), 与账号/跨平台关系解耦 ——
 * 即使档案缺失, 账号与绑定关系依然完整。
 *
 * 昵称来源是消息事件的 senderName, 由适配器提供; 框架不主动向平台查询。
 */
export class UserProfileManager {
	db: sqlite.Database;
	/**
	 * 昵称缓存: 消息是高频路径, 每条都读一次库没必要。
	 * 缓存只用于判断"是否变化", 命中相同昵称时直接跳过写库。
	 */
	private cache = new Map<string, string>();

	constructor(db: sqlite.Database) {
		this.db = db;
	}

	init() {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);
		this.db.exec(`
            -- 用户档案表：展示信息, 与账号表一对一
            CREATE TABLE IF NOT EXISTS user_profile (
                uuid       TEXT PRIMARY KEY,            -- 账号 UUID
                name       TEXT NOT NULL DEFAULT '',    -- 昵称
                avatar     TEXT NOT NULL DEFAULT '',    -- 头像 URL
                updated_at INTEGER NOT NULL DEFAULT 0   -- 最近更新时间(ms)
            );
        `);
	}

	/**
	 * 记录一次昵称。值未变化时不落盘; 空昵称忽略, 避免用空值覆盖已有档案。
	 *
	 * 失败只吞掉 (消息处理主流程不应被档案写入影响), 缓存不更新以便下次重试。
	 */
	touch(accountId: string, name: string): void {
		if (!this.db.open) return;
		if (!accountId || !name) return;
		if (this.cache.get(accountId) === name) return;

		try {
			this.db.prepare(`
				INSERT INTO user_profile (uuid, name, updated_at)
				VALUES (?, ?, ?)
				ON CONFLICT(uuid) DO UPDATE SET
					name = excluded.name,
					updated_at = excluded.updated_at
			`).run(accountId, name, Date.now());
		} catch {
			return;
		}

		this.cache.set(accountId, name);
	}

	/** 查询单个账号的档案 */
	get(accountId: string): UserProfile | null {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const row = this.db.prepare(
			'SELECT uuid, name, avatar, updated_at FROM user_profile WHERE uuid = ?'
		).get(accountId) as { uuid: string; name: string; avatar: string; updated_at: number } | undefined;

		return row ? toProfile(row) : null;
	}

	/** 批量查询档案 (列表页用, 避免逐条查询) */
	getMany(accountIds: string[]): Map<string, UserProfile> {
		if (!this.db.open) throw new StateError(`Internal表连接已关闭`);

		const result = new Map<string, UserProfile>();
		if (accountIds.length === 0) return result;

		const placeholders = accountIds.map(() => "?").join(", ");
		const rows = this.db.prepare(`
			SELECT uuid, name, avatar, updated_at FROM user_profile WHERE uuid IN (${placeholders})
		`).all(...accountIds) as { uuid: string; name: string; avatar: string; updated_at: number }[];

		for (const row of rows) result.set(row.uuid, toProfile(row));
		return result;
	}
}

function toProfile(row: { uuid: string; name: string; avatar: string; updated_at: number }): UserProfile {
	return {
		accountId: row.uuid,
		name: row.name,
		avatar: row.avatar,
		updatedAt: row.updated_at,
	};
}
