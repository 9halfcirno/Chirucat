import { createHash } from "node:crypto";
import type { PluginKVAPI } from "../../src/plugin/contexts/types";
import type Logger from "../../src/utils/logger";
import type { HttpMethod, QQApi } from "./api";

/**
 * 图片素材管理 (TTL + LRU + 平台配额自愈)
 *
 * 职责单一: 输入图片 Buffer, 输出当前可用的 qqbot-media:// 素材 URL。
 * token / 请求封装 / KV 全部依赖外部注入 —— 分别复用 QQApi.request(路径相对 /v2/,
 * 自带 Authorization)与 ctx.kv(JSON 同步 KV), 本模块不碰鉴权与心跳。
 *
 * 三层复用:
 * 1. 进程内 LRU(Map 插入序, 队首最久未用);
 * 2. KV 持久化(sha1 主键 + image_id 反查索引), 重启不重传;
 * 3. warmUp() 凭 GET /v2/media-images 列表重建, TTL 以服务端 expires_at 为准。
 *
 * 平台约束: 单机器人 100 张上限, 超限 prepare 报 40035007;
 * 素材滑动过期(消息引用即顺延)。配额冲突时先删 orphan(无法关联 sha1 的遗留素材),
 * 再淘汰自己的最旧 LRU 条目, 每次淘汰都真实调用 DELETE 释放配额。
 */

/** prepare/complete 撞上限的错误码 */
const ERR_QUOTA_FULL = 40035007;
/** 服务端未给出可用 ttl 时的兜底滑动窗口 */
const DEFAULT_ROLLING_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 本地判定早于服务端一天, 宁可多传一次也不把悬空 URL 交给消息 */
const TTL_SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000;
/** presigned 直传超时 */
const UPLOAD_TIMEOUT_MS = 60_000;

/** KV 中持久化的素材记录; preview_url 是签名外链, 按文档不入库 */
export interface KvImageRecord {
	sha1: string;
	imageId: string;
	url: string;
	ttlMs: number;
	lastUploadAt: number;
	lastUsedAt: number;
}

/** GET /v2/media-images 列表项 */
export interface ServerMaterial {
	imageId: string;
	url: string;
	fileName: string;
	createdAtMs: number;
	expiresAtMs: number;
	/** previewUrl 仅短期内存使用(签名外链), 勿写入 KV */
	previewUrl?: string | undefined;
}

export interface WarmUpStats {
	/** 凭 KV 反查索引恢复成可复用条目的素材数 */
	reused: number;
	/** 服务端有效但本地无 sha1 映射、仅登记为配额牺牲位的素材数 */
	orphans: number;
	/** 列表接口调用失败, 本次未重建 */
	failed: boolean;
}

export interface ImageCacheDeps {
	/** 复用适配器已有的请求封装(路径相对 v2/, 抛 QQApiError) */
	request: QQApi["request"];
	/** 适配器 ctx.kv */
	kv: PluginKVAPI;
	logger: Logger;
	/** 本地跟踪的素材上限, 默认与平台上限一致 */
	maxEntries?: number;
	/** KV 键前缀, 与其他插件数据隔离 */
	keyPrefix?: string;
}

interface CacheEntry {
	sha1: string;
	imageId: string;
	url: string;
	ttlMs: number;
	expireAt: number;
	lastUploadAt: number;
}

/** 素材接口业务错误(HTTP 200 但 code != 0) */
export class ImageApiError extends Error {
	constructor(readonly code: number | undefined, message: string) {
		super(message);
		this.name = "ImageApiError";
	}
}

export class ImageMaterialCache {
	/** 插入序即 LRU 序, 队首最旧 */
	private entries = new Map<string, CacheEntry>();
	/** 串行锁: 保证 maxEntries 精确、并发同图不重复上传 */
	private lock: Promise<unknown> = Promise.resolve();
	/** image_id -> createdAtMs, 服务端有效但不属于本缓存映射的遗留素材 */
	private orphans = new Map<string, number>();
	private readonly request: QQApi["request"];
	private readonly kv: PluginKVAPI;
	private readonly logger: Logger;
	private maxEntries: number;
	private readonly keyPrefix: string;
	private hydrated = false;

	constructor(deps: ImageCacheDeps) {
		this.request = deps.request;
		this.kv = deps.kv;
		this.logger = deps.logger;
		this.maxEntries = deps.maxEntries ?? 100;
		this.keyPrefix = deps.keyPrefix ?? "media:image:";
	}

	/**
	 * 传入图片 Buffer, 返回当前可用的 qqbot-media:// URL(命中复用或新上传)。
	 * 该 URL 用于消息 markdown: `![说明 #宽px #高px](url)`。
	 */
	async getImageUrl(src: { buffer: Buffer; fileName?: string; contentType?: string }): Promise<string> {
		const sha1 = createHash("sha1").update(src.buffer).digest("hex");
		const run = this.lock.then(() => this.getImageUrlLocked(sha1, src));
		this.lock = run.catch(() => {});
		return run;
	}

	/**
	 * 冷启动重建: 拉服务端有效素材列表恢复 LRU。
	 * 建议在适配器 start() 里 void 调用, 失败只降级不抛(后续按需上传)。
	 */
	async warmUp(): Promise<WarmUpStats> {
		const run = this.lock.then(() => this.hydrateLocked());
		this.lock = run.catch(() => {});
		return run;
	}

	/**
	 * 调整素材跟踪上限(配置热更新)。
	 * 调小只影响后续淘汰节奏, 不立即删除已有素材 —— 避免改个配置就引发一波平台 DELETE。
	 */
	setMaxEntries(n: number): void {
		const next = Math.max(1, Math.floor(n));
		if (next === this.maxEntries) return;
		this.maxEntries = next;
	}

	/** 主动删除某张图对应的素材(内存、KV 与服务端)。 */
	async removeImage(buffer: Buffer): Promise<void> {
		const sha1 = createHash("sha1").update(buffer).digest("hex");
		const run = this.lock.then(() => this.removeImageLocked(sha1));
		this.lock = run.catch(() => {});
		return run;
	}

	/** 服务端当前有效素材(游标分页取全); previewUrl 仅在此返回值里短期使用, 勿持久化 */
	async listMaterials(): Promise<ServerMaterial[]> {
		const out: ServerMaterial[] = [];
		let cursor = "";
		for (let page = 0; page < 100; page++) {
			const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
			const data = await this.call<{ images?: Record<string, unknown>[]; next_cursor?: string }>("GET", `media-images${qs}`);
			for (const it of data?.images ?? []) {
				const imageId = String(it.image_id ?? "");
				const url = String(it.url ?? "");
				if (!imageId || !url) continue;
				out.push({
					imageId,
					url,
					fileName: String(it.file_name ?? ""),
					createdAtMs: toMs(it.created_at),
					expiresAtMs: toMs(it.expires_at),
					previewUrl: it.preview_url === undefined ? undefined : String(it.preview_url)
				});
			}
			cursor = data?.next_cursor ?? "";
			if (!cursor) break;
		}
		return out;
	}

	private async getImageUrlLocked(sha1: string, src: { buffer: Buffer; fileName?: string; contentType?: string }): Promise<string> {
		const now = Date.now();
		const hit = this.entries.get(sha1);
		if (hit && hit.expireAt > now) {
			this.entries.delete(sha1); // touch: 移到 LRU 队尾
			hit.expireAt = now + hit.ttlMs;
			this.entries.set(sha1, hit);
			this.kvSave(hit, now);
			return hit.url;
		}
		if (hit) {
			this.entries.delete(sha1);
			this.kvErase(sha1, hit.imageId); // 本地过期 = 服务端已回收, 只清账不补发 DELETE
		}

		// 内存未命中: 查 KV, 上次上传的素材可能仍在滑动有效期内
		const persisted = this.kvLookup(sha1, now);
		if (persisted) {
			this.ensureCapacity();
			const entry: CacheEntry = { ...persisted, sha1, expireAt: now + persisted.ttlMs };
			this.entries.set(sha1, entry);
			this.kvSave(entry, now);
			return entry.url;
		}

		this.ensureCapacity();
		const meta = await this.uploadWithRetry(src, sha1);
		const ttlMs = Math.max(60_000, (meta.ttlSeconds ?? DEFAULT_ROLLING_TTL_MS / 1000) * 1000 - TTL_SAFETY_MARGIN_MS);
		const entry: CacheEntry = { sha1, imageId: meta.imageId, url: meta.url, ttlMs, expireAt: now + ttlMs, lastUploadAt: now };
		this.entries.set(sha1, entry);
		this.kvSave(entry, now);
		return entry.url;
	}

	private async removeImageLocked(sha1: string): Promise<void> {
		const entry = this.entries.get(sha1);
		if (entry) {
			this.entries.delete(sha1);
			this.kvErase(sha1, entry.imageId);
			await this.deleteMaterial(entry.imageId);
			return;
		}
		const record = this.kvGetBySha1(sha1);
		if (record) {
			this.kvErase(sha1, record.imageId);
			await this.deleteMaterial(record.imageId);
		}
	}

	private async hydrateLocked(): Promise<WarmUpStats> {
		if (this.hydrated) return { reused: 0, orphans: 0, failed: false };
		this.hydrated = true;
		const now = Date.now();
		let listed: ServerMaterial[];
		try {
			listed = await this.listMaterials();
		} catch (e) {
			this.logger.warn(`ImageCache: warmUp 列表接口失败, 降级为按需上传: ${String(e)}`);
			return { reused: 0, orphans: 0, failed: true };
		}
		const alive = listed.filter((m) => m.expiresAtMs > now).sort((a, b) => a.createdAtMs - b.createdAtMs);
		const room = Math.max(0, this.maxEntries - this.entries.size);
		const take = alive.slice(Math.max(0, alive.length - room)); // 只收编最近的 room 张, 溢出部分留给自然过期
		let reused = 0;
		let orphans = 0;
		for (const m of take) {
			if ([...this.entries.values()].some((e) => e.imageId === m.imageId)) continue;
			const sha1 = this.kvGetByImageId(m.imageId);
			if (!sha1) {
				this.orphans.set(m.imageId, m.createdAtMs); // 无本地映射: 只能当配额牺牲位
				orphans++;
				continue;
			}
			if (this.entries.has(sha1)) continue;
			this.entries.set(sha1, {
				sha1,
				imageId: m.imageId,
				url: m.url,
				ttlMs: Math.max(60_000, m.expiresAtMs - now),
				expireAt: m.expiresAtMs, // 服务端权威 TTL, 消息引用会顺延
				lastUploadAt: m.createdAtMs
			});
			reused++;
		}
		this.logger.info(`ImageCache: warmUp 完成 reused=${reused} orphans=${orphans} total=${listed.length}`);
		return { reused, orphans, failed: false };
	}

	private ensureCapacity(): void {
		// 同步淘汰只腾位置并清账; 真正的 DELETE 在这里等不到锁外异步, 直接发起即可
		while (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			const entry = this.entries.get(oldest)!;
			this.entries.delete(oldest);
			this.kvErase(oldest, entry.imageId);
			void this.deleteMaterial(entry.imageId).catch(() => {});
		}
	}

	private async uploadWithRetry(src: { buffer: Buffer; fileName?: string; contentType?: string }, sha1: string) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.doUpload(src, sha1);
			} catch (e) {
				if (isQuotaError(e) && attempt < 3) {
					if (await this.deleteOldestOrphan()) continue;
					if (this.entries.size > 0) {
						await this.evictAndDeleteOldest();
						continue;
					}
				}
				throw e;
			}
		}
	}

	private async evictAndDeleteOldest(): Promise<void> {
		const oldest = this.entries.keys().next().value as string | undefined;
		if (oldest === undefined) return;
		const entry = this.entries.get(oldest)!;
		this.entries.delete(oldest);
		this.kvErase(oldest, entry.imageId);
		await this.deleteMaterial(entry.imageId);
	}

	private async deleteOldestOrphan(): Promise<boolean> {
		let oldestId: string | undefined;
		let oldestAt = Infinity;
		for (const [id, at] of this.orphans) {
			if (at < oldestAt) {
				oldestAt = at;
				oldestId = id;
			}
		}
		if (oldestId === undefined) return false;
		this.orphans.delete(oldestId);
		await this.deleteMaterial(oldestId);
		return true;
	}

	private async doUpload(src: { buffer: Buffer; fileName?: string; contentType?: string }, sha1: string) {
		const bytes = src.buffer;
		const md5 = createHash("md5").update(bytes).digest("hex");
		const fileName = src.fileName ?? `${sha1.slice(0, 12)}.jpg`;
		const contentType = src.contentType ?? guessContentType(fileName);

		const prepared = await this.call<{ upload_id?: string; presigned_url?: string }>("POST", "media-images/prepare", {
			file_name: fileName,
			file_size: bytes.byteLength,
			content_type: contentType,
			md5,
			sha1
		});
		if (!prepared.upload_id || !prepared.presigned_url) throw new ImageApiError(undefined, `prepare 响应缺少 upload_id/presigned_url`);

		// presigned 直传不走 QQApi(那是另一套 COS 域名的 URL), Content-Type 必须与 prepare 申报一致
		// 逐字段赋值而非对象字面量: exactOptionalPropertyTypes 下 body 不接受 undefined 属性值
		const putInit: RequestInit = {
			method: "PUT",
			headers: { "Content-Type": contentType },
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
		};
		putInit.body = bytes;
		const put = await fetch(prepared.presigned_url, putInit);
		if (!put.ok) throw new ImageApiError(undefined, `直传失败 HTTP ${put.status}`);

		const completed = await this.call<{ image_id?: string; url?: string; ttl?: number }>("POST", "media-images/complete", {
			upload_id: prepared.upload_id,
			md5
		});
		if (!completed.image_id || !completed.url) throw new ImageApiError(undefined, `complete 响应缺少 image_id/url`);
		return { imageId: completed.image_id, url: completed.url, ttlSeconds: normalizeTtl(completed.ttl) };
	}

	/** 已带 token 与 HTTP 错误处理, 这里只补业务 code 检查(QQ 接口会用 HTTP 200 + code!=0 报错) */
	private async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
		const data = body === undefined
			? await this.request<T>(method, path)
			: await this.request<T>(method, path, body);
		const code = (data as { code?: number } | null | undefined)?.code;
		if (code !== undefined && code !== 0) {
			const message = String((data as { message?: string } | null)?.message ?? "unknown");
			throw new ImageApiError(code, `素材接口 ${path} 失败: code=${code} message=${message}`);
		}
		return data as T;
	}

	private async deleteMaterial(imageId: string): Promise<void> {
		try {
			await this.call("DELETE", `media-images/${imageId}/delete`);
		} catch (e) {
			// 素材可能已被系统回收, 删除失败不影响账本一致性
			this.logger.info(`ImageCache: 删除素材 ${imageId} 未确认成功: ${String(e)}`);
		}
	}

	// ---------- KV: 主键 sha1 + 反查索引 byid, 同步读写 ----------

	private kvKey(sha1: string): string {
		return this.keyPrefix + sha1;
	}

	private kvIdKey(imageId: string): string {
		return `${this.keyPrefix}byid:${imageId}`;
	}

	private kvGetBySha1(sha1: string): KvImageRecord | undefined {
		return this.kv.get<KvImageRecord>(this.kvKey(sha1));
	}

	/** 反查 image_id -> sha1; 记录不一致(残留旧索引)时视为查不到 */
	private kvGetByImageId(imageId: string): string | undefined {
		const record = this.kv.get<KvImageRecord>(this.kvIdKey(imageId));
		return record && record.imageId === imageId ? record.sha1 : undefined;
	}

	private kvSave(entry: CacheEntry, usedAt: number): void {
		const record: KvImageRecord = {
			sha1: entry.sha1,
			imageId: entry.imageId,
			url: entry.url,
			ttlMs: entry.ttlMs,
			lastUploadAt: entry.lastUploadAt,
			lastUsedAt: usedAt
		};
		this.kv.set(this.kvKey(entry.sha1), record);
		this.kv.set(this.kvIdKey(entry.imageId), record);
	}

	private kvErase(sha1: string, imageId?: string): void {
		this.kv.delete(this.kvKey(sha1));
		if (imageId) this.kv.delete(this.kvIdKey(imageId));
	}

	/** 读 KV 主记录并判定是否仍在滑动有效期内; 过期记录顺手清除 */
	private kvLookup(sha1: string, now: number): Omit<CacheEntry, "expireAt"> | undefined {
		const record = this.kvGetBySha1(sha1);
		if (!record) return undefined;
		if (!record.imageId || !record.url || !record.ttlMs || !record.lastUsedAt) {
			this.kvErase(sha1, record.imageId);
			return undefined;
		}
		if (record.lastUsedAt + record.ttlMs <= now) {
			this.kvErase(sha1, record.imageId);
			return undefined;
		}
		return { sha1, imageId: record.imageId, url: record.url, ttlMs: record.ttlMs, lastUploadAt: record.lastUploadAt };
	}
}

/** 配额已满: 业务错走 ImageApiError.code; HTTP 非 2xx 时 QQApiError 消息里带 code 数字 */
function isQuotaError(e: unknown): boolean {
	if (e instanceof ImageApiError) return e.code === ERR_QUOTA_FULL;
	return e instanceof Error && e.message.includes(String(ERR_QUOTA_FULL));
}

function toMs(secs: unknown): number {
	const n = Number(secs);
	return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}

function normalizeTtl(ttl: unknown): number | undefined {
	const n = Number(ttl);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	// 实测为秒(7776000=90d); 若平台改发毫秒级大数, 按毫秒折算
	return n > 86_400_000 ? n / 1000 : n;
}

function guessContentType(fileName: string): string {
	const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
	const map: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
	return map[ext] ?? "image/jpeg";
}
