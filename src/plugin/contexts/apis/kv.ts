import sqlite from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { PluginKVAPI } from "../types";

/** KVStore.init() 的可选配置 */
export interface KVInitOptions {
	/** 是否开启 WAL 模式; 默认 true。适合多进程/读写并发。 */
	wal?: boolean;
	/** SQLite synchronous 级别; 默认 "normal"。WAL 下 "normal" 已足够安全。 */
	synchronous?: "off" | "normal" | "full" | "extra";
	/** 锁等待超时(ms); 默认 5000。仅在多进程写同一文件时有意义。 */
	busyTimeout?: number;
	/** 是否复用已编译的 SQL 语句; 默认 true。 */
	prepareCache?: boolean;
}

/** 所有 SQL 都是常量字面量, 才能安全地拿字符串当缓存 key */
const SQL = {
	createTable: `
		CREATE TABLE IF NOT EXISTS kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`,
	get: "SELECT value FROM kv WHERE key = ?",
	set: `
		INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			updated_at = excluded.updated_at
	`,
	has: "SELECT 1 FROM kv WHERE key = ?",
	delete: "DELETE FROM kv WHERE key = ?",
	clear: "DELETE FROM kv",
	keys: "SELECT key FROM kv ORDER BY key",
	entries: "SELECT key, value FROM kv ORDER BY key",
	list: "SELECT key, value FROM kv WHERE key GLOB ? ORDER BY key LIMIT ? OFFSET ?",
	count: "SELECT COUNT(*) AS n FROM kv",
	countPrefix: "SELECT COUNT(*) AS n FROM kv WHERE key GLOB ?",
	clearPrefix: "DELETE FROM kv WHERE key GLOB ?",
} as const;

type RawRow = { key: string; value: string };

/** 把 prefix 转成 GLOB 模式, 同时转义 GLOB 元字符 */
function globPrefix(prefix: string): string {
	let out = "";
	for (const ch of prefix) {
		switch (ch) {
			case "*": out += "[*]"; break;
			case "?": out += "[?]"; break;
			case "[": out += "[[]"; break;
			case "]": out += "[]]"; break;
			default: out += ch;
		}
	}
	return out + "*";
}

/**
 * 插件 KV 存储: 每个插件实例一个 sqlite 文件 (bot/data/plugins/<插件id>/.kv.db)
 * 数据按 bot + 插件隔离, 值统一 JSON 序列化后存入 TEXT 列
 */
export class KVStore implements PluginKVAPI {
	private db: sqlite.Database | null = null;
	/** SQL 字符串 -> 已编译语句; 为 null 表示未启用缓存 */
	private cache: Map<string, sqlite.Statement> | null = null;
	private _closed = false;

	file: string;

	constructor(file: string) {
		this.file = file;
	}

	init(options: KVInitOptions = {}): void {
		if (this.db) return; // 幂等: 重复调用不再开连接

		const {
			wal = true,
			synchronous = "normal",
			busyTimeout = 5000,
			prepareCache = true,
		} = options;

		// 目录不存在时 sqlite 无法创建文件
		fs.mkdirSync(path.dirname(this.file), { recursive: true });

		const db = new sqlite(this.file, {});
		try {
			// busy_timeout 必须最先设置, 后续 pragma 也可能撞锁
			db.pragma(`busy_timeout = ${busyTimeout}`);
			// WAL: 读写互不阻塞, 是"多进程同时打开"真正的并发方案
			if (wal) db.pragma("journal_mode = WAL");
			db.pragma(`synchronous = ${synchronous.toUpperCase()}`);

			db.exec(SQL.createTable);

			// 为将来加 TTL 等列变更留迁移入口
			const version = db.pragma("user_version", { simple: true }) as number;
			if (version < 1) db.pragma("user_version = 1");
		} catch (e) {
			// 初始化失败不能留下半开的连接
			try { db.close(); } catch { /* ignore */ }
			throw e;
		}

		this.db = db;
		this.cache = prepareCache ? new Map() : null;
		this._closed = false;
	}

	/** 当前连接; 未初始化或已关闭时给出明确错误 */
	private get conn(): sqlite.Database {
		if (this._closed) throw new Error(`KV 已关闭 (file="${this.file}")`);
		if (!this.db) throw new Error(`KV 未初始化: 请先调用 kv.init() (file="${this.file}")`);
		return this.db;
	}

	/** 统一入口: 启用缓存时按 SQL 文本复用已编译语句 */
	private prepare(sql: string): sqlite.Statement {
		if (!this.cache) return this.conn.prepare(sql);
		let stmt = this.cache.get(sql);
		if (!stmt) {
			stmt = this.conn.prepare(sql);
			this.cache.set(sql, stmt);
		}
		return stmt;
	}

	get<T = unknown>(key: string, defaultValue?: T): T | undefined {
		const row = this.prepare(SQL.get).get(key) as { value: string } | undefined;
		if (!row) return defaultValue;
		try {
			return JSON.parse(row.value) as T;
		} catch {
			// 损坏数据不应让调用方崩溃
			return defaultValue;
		}
	}

	set(key: string, value: unknown): void {
		const text = JSON.stringify(value);
		if (text === undefined) {
			throw new TypeError(`KV set: 值不可 JSON 序列化 (key="${key}")`);
		}
		this.prepare(SQL.set).run(key, text, Date.now());
	}

	has(key: string): boolean {
		return !!this.prepare(SQL.has).get(key);
	}

	delete(key: string): boolean {
		return this.prepare(SQL.delete).run(key).changes > 0;
	}

	clear(): void {
		this.prepare(SQL.clear).run();
	}

	keys(): string[] {
		const rows = this.prepare(SQL.keys).all() as { key: string }[];
		return rows.map(r => r.key);
	}

	entries(): [string, unknown][] {
		return this.parseRows(this.prepare(SQL.entries).all() as RawRow[]);
	}

	/**
	 * 列出指定前缀的键值对, 按 key 升序。
	 * @param prefix 前缀; 空串表示全部
	 * @param options.limit 最大条数, 默认 -1 (不限)
	 * @param options.offset 跳过条数, 默认 0
	 */
	list<T = unknown>(
		prefix = "",
		options: { limit?: number; offset?: number } = {},
	): [string, T][] {
		const limit = options.limit ?? -1;
		const offset = options.offset ?? 0;
		const rows = this.prepare(SQL.list).all(globPrefix(prefix), limit, offset) as RawRow[];
		return this.parseRows<T>(rows);
	}

	/** 前缀删除, 返回删除条数 */
	clearPrefix(prefix: string): number {
		return this.prepare(SQL.clearPrefix).run(globPrefix(prefix)).changes;
	}

	/** 统计条数; 不传 prefix 统计全部 */
	count(prefix?: string): number {
		const row = prefix === undefined
			? this.prepare(SQL.count).get()
			: this.prepare(SQL.countPrefix).get(globPrefix(prefix));
		return (row as { n: number }).n;
	}

	/** 在单个事务里执行 fn; fn 抛错则整体回滚 */
	tx<T>(fn: () => T): T {
		return this.conn.transaction(fn)();
	}

	/** 批量写入, 单事务一次落盘, 避免 N 次 fsync */
	setMany(entries: Iterable<readonly [string, unknown]>): void {
		const stmt = this.prepare(SQL.set);
		const now = Date.now();
		this.tx(() => {
			for (const [key, value] of entries) {
				const text = JSON.stringify(value);
				if (text === undefined) {
					throw new TypeError(`KV setMany: 值不可 JSON 序列化 (key="${key}")`);
				}
				stmt.run(key, text, now);
			}
		});
	}

	/**
	 * 关闭连接, 幂等; 插件卸载时由 PluginContext.dispose 调用。
	 * 先摘引用再 close: 即使 close 抛错, 实例也处于已关闭状态, 不会重复关闭同一连接。
	 */
	close(): void {
		if (this._closed || !this.db) return;
		const db = this.db;
		this.db = null;
		this.cache = null; // 语句随连接一起失效
		this._closed = true;
		db.close();
	}

	private parseRows<T>(rows: RawRow[]): [string, T][] {
		const out: [string, T][] = [];
		for (const r of rows) {
			try {
				out.push([r.key, JSON.parse(r.value) as T]);
			} catch {
				// 跳过损坏行, 避免一条脏数据毒化整个列表
			}
		}
		return out;
	}
}