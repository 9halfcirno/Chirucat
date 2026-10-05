import type Logger from "../../src/utils/logger";
import { QQApi, QQApiError } from "./api";
import {
	DEFAULT_UPLOAD_CONCURRENCY,
	DEFAULT_UPLOAD_RETRY_DELAY,
	DEFAULT_UPLOAD_RETRY_TIMEOUT,
	MD5_10M_SIZE,
	UPLOAD_TIMEOUT,
	type QQFileType
} from "./config";
import { md5hex, resolveFileName, sha1hex, toBuffer } from "./media";
import type {
	MediaSource,
	QQUploadConfig,
	QQUploadFileResult,
	QQUploadPart,
	QQUploadPrepareResult,
	QQSendTarget
} from "./types";

/** 重试参数(秒已被换算为毫秒) */
type RetryPolicy = { delay: number; timeout: number };

/** 分片与它在原文件中的切片 */
type UploadChunk = { part: QQUploadPart; data: Buffer };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 按服务端下发的分片表切分文件
 *
 * 每片的偏移由前序分片大小累加得到 —— 分片大小由服务端决定(默认 5MB),
 * 客户端不能自己假设固定值, 否则偏移会错位。
 *
 * **缺一片就整个失败**: 若有某片信息不可用而"跳过", 后续所有分片的偏移都会错位,
 * 等于把错误的字节上传到平台上, 而合并还会成功 —— 那是最难查的一类问题。
 *
 * 末片可能小于 block_size, 也可能被平台按默认分块大小上报, 因此末尾统一截断到文件长度;
 * 文件已切完后出现的尾随分片一律忽略, 不让无关的残缺分片搞挂一次本来完整的上传。
 *
 * @param parts 服务端下发的分片表
 * @param bytes 待上传的完整文件
 * @throws {QQApiError} 分片表缺少可用信息, 或分片总长不足文件长度时
 */
function sliceChunks(parts: QQUploadPart[] | undefined, bytes: Buffer): UploadChunk[] {
	if (!Array.isArray(parts) || parts.length === 0) return [];

	const chunks: UploadChunk[] = [];
	let offset = 0;

	// 分片按 index 升序处理, 保证偏移累加顺序与平台一致
	const ordered = [...parts].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

	for (const part of ordered) {
		// 文件已经切完: 之后的分片与本文件无关, 直接忽略 ——
		// 尾随的残缺分片不该让一次本来完整的上传失败
		if (offset >= bytes.length) break;

		if (!part.presigned_url) {
			throw new QQApiError(`分片 ${part.index ?? "?"} 缺少 presigned_url, 无法上传`);
		}

		const size = Number(part.block_size);
		if (!Number.isFinite(size) || size <= 0) {
			throw new QQApiError(`分片 ${part.index ?? "?"} 的 block_size 非法: ${part.block_size}`);
		}

		// size > 0 且 offset < bytes.length, 因此 end 必然大于 offset
		const end = Math.min(offset + size, bytes.length);
		chunks.push({ part, data: bytes.subarray(offset, end) });
		offset = end;
	}

	// 分片总长不足: 尾部不会被上传, 合并出来是残缺文件, 不如直接失败
	if (offset < bytes.length) {
		throw new QQApiError(`分片总长 ${offset} 小于文件长度 ${bytes.length}, 分片表不完整`);
	}

	return chunks;
}

/**
 * 富媒体上传
 *
 * 官方给了两条路径, 这里都实现了:
 *
 * - URL 上传: 资源已在公网可访问时, 交给平台下载转存;
 * - 分片上传: 本地 Buffer 走 upload_prepare -> PUT -> upload_part_finish -> 合并,
 *   这正是框架协议支持 `buffer` 发送意图后适配器需要补上的能力。
 *
 * 参考: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */
export class MediaUploader {
	constructor(
		private api: QQApi,
		private logger: Logger
	) { }

	/**
	 * 上传一个媒体来源, 返回可用于发送的 `file_info`
	 */
	async upload(
		target: QQSendTarget,
		source: MediaSource,
		fileType: QQFileType,
		fileName?: string
	): Promise<string> {
		if (source.kind === "url") {
			return await this.uploadByUrl(target, source.url, fileType);
		}
		return await this.uploadByBuffer(target, source.buffer, fileType, fileName);
	}

	/** URL 上传: 平台下载转存 */
	private async uploadByUrl(target: QQSendTarget, url: string, fileType: QQFileType): Promise<string> {
		const data = await this.api.request<QQUploadFileResult>(
			"POST",
			`${this.scenePath(target)}/files`,
			{ file_type: fileType, url, srv_send_msg: false },
			UPLOAD_TIMEOUT
		);
		return this.requireFileInfo(data, url);
	}

	/** 本地 Buffer 分片上传 */
	private async uploadByBuffer(
		target: QQSendTarget,
		view: NodeJS.ArrayBufferView,
		fileType: QQFileType,
		fileName?: string
	): Promise<string> {
		const bytes = toBuffer(view);
		const name = resolveFileName(bytes, fileType, fileName);
		const scope = this.scenePath(target);

		// 1. 预上传: 交校验值, 换 upload_id 与各分片预签名地址
		const prepared = await this.api.request<QQUploadPrepareResult>(
			"POST",
			`${scope}/upload_prepare`,
			{
				file_type: fileType,
				file_size: String(bytes.length),
				file_name: name,
				md5: md5hex(bytes),
				sha1: sha1hex(bytes),
				// 前 ~10MB 的 MD5, 供服务端做秒传判断
				md5_10m: md5hex(bytes.subarray(0, MD5_10M_SIZE))
			},
			UPLOAD_TIMEOUT
		);

		const uploadId = prepared?.upload_id;
		if (!uploadId) {
			throw new QQApiError(`预上传响应缺少 upload_id: ${JSON.stringify(prepared)}`);
		}

		const chunks = sliceChunks(prepared.parts, bytes);
		if (chunks.length === 0) {
			throw new QQApiError(`预上传响应没有可用的分片: ${JSON.stringify(prepared)}`);
		}

		const retry = this.retryPolicy(prepared.upload_config);
		const concurrency = this.concurrency(prepared.upload_config);

		this.logger.debug(
			`分片上传 ${name}: ${bytes.length}B / ${chunks.length} 片, 并发 ${concurrency}`
		);

		// 2 & 3. 逐片 PUT + 通知完成
		await this.runPool(chunks, concurrency, (chunk) =>
			this.uploadChunk(scope, uploadId, chunk, retry)
		);

		// 4. 合并分片, 拿 file_info
		const merged = await this.api.request<QQUploadFileResult>(
			"POST",
			`${scope}/files`,
			{ file_type: fileType, srv_send_msg: false, file_name: name, upload_id: uploadId },
			UPLOAD_TIMEOUT
		);

		return this.requireFileInfo(merged, name);
	}

	/** 上传单片的完整流程: PUT 分片 -> 通知服务端 -> 失败重试 */
	private async uploadChunk(
		scope: string,
		uploadId: string,
		chunk: UploadChunk,
		retry: RetryPolicy
	): Promise<void> {
		const { part, data } = chunk;
		const deadline = Date.now() + retry.timeout;
		let attempt = 0;

		for (; ;) {
			attempt++;
			try {
				await this.putChunk(part.presigned_url as string, data);

				// 通知服务端该片完成; 平台要求每片 PUT 成功后都要调一次
				await this.api.request(
					"POST",
					`${scope}/upload_part_finish`,
					{
						upload_id: uploadId,
						part_index: part.index,
						block_size: String(data.length),
						md5: md5hex(data)
					},
					UPLOAD_TIMEOUT
				);
				return;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (Date.now() >= deadline) {
					throw new QQApiError(`分片 ${part.index ?? "?"} 上传失败(已重试 ${attempt} 次): ${msg}`);
				}
				this.logger.warn(
					`分片 ${part.index ?? "?"} 第 ${attempt} 次上传失败, ${retry.delay}ms 后重试: ${msg}`
				);
				await sleep(retry.delay);
			}
		}
	}

	/** 把分片 PUT 到预签名地址(该地址自带鉴权, 不能带 QQ 的 Authorization) */
	private async putChunk(presignedUrl: string, data: Buffer): Promise<void> {
		let response: Response;
		try {
			response = await fetch(presignedUrl, {
				method: "PUT",
				// undici 运行时完全接受 Buffer(Uint8Array 子类); 断言只为绕过
				// @types/node 中 BodyInit 对新版泛型 TypedArray 的过窄声明
				body: data as unknown as BodyInit,
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT)
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new QQApiError(`分片 PUT 失败: ${msg}`);
		}

		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new QQApiError(`分片 PUT 失败 (${response.status}): ${detail}`, response.status);
		}
	}

	/**
	 * 固定并发跑一批任务
	 *
	 * 用游标共享而非按批分组: 某个慢分片不会拖住整批, 且并发数完全由平台下发值决定。
	 */
	private async runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
		let cursor = 0;
		const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (cursor < items.length) {
				const current = items[cursor++];
				if (current === undefined) break;
				await worker(current);
			}
		});

		// Promise.all 会让第一个失败立即向上抛; 其余 runner 仍会自然跑完当前这一片
		await Promise.all(runners);
	}

	/** 服务端下发的重试参数(秒 -> 毫秒), 非法时用默认值 */
	private retryPolicy(config: QQUploadConfig | undefined): RetryPolicy {
		const delay = Number(config?.retry_delay);
		const timeout = Number(config?.retry_timeout);
		return {
			delay: Number.isFinite(delay) && delay > 0 ? delay * 1000 : DEFAULT_UPLOAD_RETRY_DELAY,
			timeout: Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : DEFAULT_UPLOAD_RETRY_TIMEOUT
		};
	}

	/** 服务端下发的并发数, 非法时用默认值 */
	private concurrency(config: QQUploadConfig | undefined): number {
		const value = Number(config?.concurrency);
		return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_UPLOAD_CONCURRENCY;
	}

	/** 上传接口成功但缺 file_info 不能算成功: 没有它就没法发消息 */
	private requireFileInfo(data: QQUploadFileResult | null, label: string): string {
		if (!data?.file_info) {
			throw new QQApiError(`上传成功但响应缺少 file_info (${label}): ${JSON.stringify(data)}`);
		}
		return data.file_info;
	}

	/** 群聊/单聊在接口路径上的分段名 */
	private scenePath(target: QQSendTarget): string {
		return target.type === "group" ? `groups/${target.id}` : `users/${target.id}`;
	}
}
