import sqlite from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { PluginKVAPI } from "../types";

/**
 * 插件 KV 存储: 每个插件实例一个 sqlite 文件 (bot/data/plugins/<插件id>/.kv.db)
 * 数据按 bot + 插件隔离, 值统一 JSON 序列化后存入 TEXT 列
 */
export class KVStore implements PluginKVAPI {
	db: sqlite.Database;

	private _closed = false;

	constructor(file: string) {
		// 目录不存在时 sqlite 无法创建文件, 先保证目录存在
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.db = new sqlite(file, {});
		// 多进程同时打开同一 db 文件时, 避免写入撞 SQLITE_BUSY
		this.db.pragma("busy_timeout = 5000");
		this.init();
	}

	private init() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
	}

	get<T = unknown>(key: string, defaultValue?: T): T | undefined {
		const row = this.db.prepare(
			'SELECT value FROM kv WHERE key = ?'
		).get(key) as { value: string } | undefined;

		if (!row) return defaultValue;
		return JSON.parse(row.value) as T;
	}

	set(key: string, value: unknown): void {
		const text = JSON.stringify(value);
		if (text === undefined) {
			throw new TypeError(`KV set: 值不可 JSON 序列化 (key="${key}")`);
		}
		this.db.prepare(`
			INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
				value = excluded.value,
				updated_at = excluded.updated_at
		`).run(key, text, Date.now());
	}

	has(key: string): boolean {
		return !!this.db.prepare('SELECT 1 FROM kv WHERE key = ?').get(key);
	}

	delete(key: string): boolean {
		return this.db.prepare('DELETE FROM kv WHERE key = ?').run(key).changes > 0;
	}

	clear(): void {
		this.db.exec('DELETE FROM kv');
	}

	keys(): string[] {
		const rows = this.db.prepare('SELECT key FROM kv').all() as { key: string }[];
		return rows.map(r => r.key);
	}

	entries(): [string, unknown][] {
		const rows = this.db.prepare('SELECT key, value FROM kv').all() as { key: string; value: string }[];
		return rows.map(r => [r.key, JSON.parse(r.value)]);
	}

	/**
	 * 关闭数据库连接, 幂等; 插件卸载时由 PluginContext.dispose 调用
	 */
	close(): void {
		if (this._closed) return;
		this._closed = true;
		this.db.close();
	}
}
