import { createHash } from "node:crypto";
import { MEDIA_FILE_NAME, type QQFileType } from "./config";

/**
 * 富媒体二进制处理
 *
 * 协议里的 `MessageBlockSend` 只给了 `buffer`, 没给文件名/格式;
 * 而 QQ 的分片上传必须带 `file_name`, 且按格式做限制(png/jpg、mp4、silk)。
 * 因此这里按文件头(magic bytes)推断扩展名, 避免"名字说是 png 其实是 jpg"
 * 被平台以 850019 (不支持的文件格式) 拒绝。
 */

/** 描述一个意外值的类型, 用于报错 */
function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return `string(${value.length} 字符)`;
	if (Array.isArray(value)) return "Array";
	return typeof value;
}

/**
 * 把协议里的 ArrayBufferView 归一成 Buffer(不复制同一块内存)
 *
 * 这里刻意加一次运行时校验: 协议要求媒体块的 `buffer` 是 `ArrayBufferView`, 但
 * TypeScript 在插件沙箱里拦不住错误输入 —— `ctx.plugin.read()` 的返回类型是
 * `string | Buffer`, 传了 encoding 时运行时拿到的是 string, 而 `as Buffer` 只是
 * 编译期断言, 擦除后什么也不做。
 *
 * 不做这层校验的话, 读一个字符串的 `.buffer` 会得到 `undefined`, 最终抛出 Node 内部那句
 * "The first argument must be of type string or an instance of Buffer..." ——
 * 报错里完全看不出是调用方传错了类型。
 *
 * @throws {TypeError} 传入的不是 ArrayBufferView 时
 */
export function toBuffer(view: NodeJS.ArrayBufferView): Buffer {
	if (Buffer.isBuffer(view)) return view;

	if (!ArrayBuffer.isView(view)) {
		throw new TypeError(
			`媒体块的 buffer 必须是 Buffer/ArrayBufferView, 实际收到 ${describeValue(view)}。` +
			`提示: ctx.plugin.read/ctx.fs.read 传入 encoding 时返回的是 string, ` +
			`需要字节时应不传 encoding(拿到 Buffer)或自行 Buffer.from(str, "latin1")。`
		);
	}

	return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

export function md5hex(data: Buffer): string {
	return createHash("md5").update(data).digest("hex");
}

export function sha1hex(data: Buffer): string {
	return createHash("sha1").update(data).digest("hex");
}

/** 读取 [start, end) 的 latin1 文本, 越界部分自动截断 */
function ascii(buf: Buffer, start: number, end: number): string {
	if (start >= buf.length) return "";
	return buf.subarray(start, Math.min(end, buf.length)).toString("latin1");
}

/** 文件头匹配表: 命中即采用该扩展名 */
const MAGIC_RULES: Array<{ ext: string; match: (buf: Buffer) => boolean }> = [
	{ ext: "png", match: (b) => b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n" },
	{ ext: "jpg", match: (b) => b.length >= 3 && ascii(b, 0, 3) === "\xff\xd8\xff" },
	{ ext: "gif", match: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a" },
	{ ext: "webp", match: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
	{ ext: "bmp", match: (b) => ascii(b, 0, 2) === "BM" },
	{ ext: "mp4", match: (b) => ascii(b, 4, 8) === "ftyp" },
	{ ext: "silk", match: (b) => ascii(b, 0, 9).includes("SILK") },
	{ ext: "amr", match: (b) => ascii(b, 0, 5) === "#!AMR" },
	{ ext: "mp3", match: (b) => ascii(b, 0, 3) === "ID3" || (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) },
	{ ext: "wav", match: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE" },
	{ ext: "ogg", match: (b) => ascii(b, 0, 4) === "OggS" }
];

/** 按文件头推断扩展名, 认不出来时回落到 bin */
export function sniffExt(view: NodeJS.ArrayBufferView): string {
	const buf = toBuffer(view);
	for (const rule of MAGIC_RULES) {
		if (rule.match(buf)) return rule.ext;
	}
	return "bin";
}

/**
 * 生成一个平台能接受的文件名
 *
 * 优先使用调用方给定的名字(有扩展名时直接用); 否则按文件头推断格式,
 * 拼成 `<类型>.<ext>`。
 */
export function resolveFileName(view: NodeJS.ArrayBufferView, fileType: QQFileType, given?: string): string {
	const name = given?.trim();
	if (name) return name;
	return `${MEDIA_FILE_NAME[fileType]}.${sniffExt(view)}`;
}
