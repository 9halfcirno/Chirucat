// atomic-write.ts
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

export interface AtomicWriteOptions {
	/** 字符串写入时的编码，默认 utf8 */
	encoding?: BufferEncoding;
	/** 目标文件权限（如 0o600）。不传时沿用已存在文件的权限 */
	mode?: number;
	/** 目标已存在时是否保留其权限，默认 true */
	preserveMode?: boolean;
	/** rename 失败（EPERM/EACCES/EBUSY）时的重试次数，默认 5（主要给 Windows 用） */
	retries?: number;
	/** 重试基础间隔（线性退避），默认 50ms */
	retryDelayMs?: number;
	/** 是否 fsync 父目录，确保 rename 本身也落盘，默认 true */
	fsyncDir?: boolean;
	/** 父目录不存在时是否自动创建，默认 false */
	mkdirp?: boolean;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 原子写入文件。
 * 写入过程中任何时刻崩溃，目标文件要么是旧内容，要么是新内容，不会出现半截内容。
 */
export async function atomicWriteFile(
	filePath: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const {
		encoding = 'utf8',
		mode,
		preserveMode = true,
		retries = 5,
		retryDelayMs = 50,
		fsyncDir: shouldFsyncDir = true,
		mkdirp = false,
	} = options;

	const absPath = path.resolve(filePath);
	const dir = path.dirname(absPath);
	const base = path.basename(absPath);

	if (mkdirp) {
		await fs.mkdir(dir, { recursive: true });
	}

	const buf =
		typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);

	// 解析最终权限：显式 mode > 已存在文件权限 > 交给 umask 决定
	let finalMode = mode;
	if (finalMode === undefined && preserveMode) {
		try {
			finalMode = (await fs.stat(absPath)).mode & 0o777;
		} catch {
			// 目标文件不存在，忽略
		}
	}

	// 临时文件必须放在同一目录（同一文件系统），rename 才是原子的
	const tmpPath = path.join(
		dir,
		`.${base}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}.tmp`,
	);

	let handle: FileHandle | undefined;
	try {
		// 'wx' 保证不会覆盖已存在的临时文件
		handle = await fs.open(tmpPath, 'wx', finalMode ?? 0o666);

		await handle.writeFile(buf);
		// 先把数据刷到磁盘，再 rename，避免断电后出现“空文件”
		await handle.sync();

		if (finalMode !== undefined) {
			// open 的 mode 会被 umask 削掉，这里显式校正
			await handle.chmod(finalMode).catch(() => { });
		}

		await handle.close();
		handle = undefined;

		await renameWithRetry(tmpPath, absPath, retries, retryDelayMs);

		if (shouldFsyncDir) {
			await fsyncDirectory(dir);
		}
	} catch (err) {
		await handle?.close().catch(() => { });
		await fs.rm(tmpPath, { force: true }).catch(() => { });
		throw err;
	}
}

/** 原子写入 JSON（自动缩进 + 结尾换行） */
export async function atomicWriteJson(
	filePath: string,
	value: unknown,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const text = JSON.stringify(value, null, 2) + '\n';
	await atomicWriteFile(filePath, text, options);
}

async function renameWithRetry(
	from: string,
	to: string,
	retries: number,
	delayMs: number,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// Windows 上目标被占用（杀软扫描 / 编辑器）时会短暂失败
			const retriable =
				code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
			if (!retriable || attempt >= retries) throw err;
			await sleep(delayMs * (attempt + 1));
		}
	}
}

async function fsyncDirectory(dir: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(dir, 'r');
		await handle.sync();
	} catch {
		// Windows 等平台不支持对目录 fsync，忽略即可
	} finally {
		await handle?.close().catch(() => { });
	}
}