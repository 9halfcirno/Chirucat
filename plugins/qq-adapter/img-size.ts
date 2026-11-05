export type ImageSize = { width: number; height: number };

/** 表示当前字节数不够，需要更多数据 */
const NEED_MORE = Symbol("need-more");

async function fetchHead(url: string, bytes: number): Promise<{ buf: Uint8Array; partial: boolean } | null> {
	try {
		const resp = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: AbortSignal.timeout(8000) });
		if (!resp.ok && resp.status !== 206) return null;
		const buf = new Uint8Array(await resp.arrayBuffer());
		// 206 = Partial Content，说明服务器支持 Range
		return { buf, partial: resp.status === 206 };
	} catch {
		return null;
	}
}

export async function getImageSize(url: string): Promise<ImageSize | null> {
	let bytes = 2048;
	const maxBytes = 65536;
	while (bytes <= maxBytes) {
		const res = await fetchHead(url, bytes);
		if (!res) return null;
		const result = parseImageSize(res.buf);
		if (result === NEED_MORE) {
			// 非 partial 说明拿到的就是完整文件，再解析不出就是不支持
			if (!res.partial) return null;
			bytes *= 2;
			continue;
		}
		return result;
	}
	return null;
}

export function parseImageSize(buf: Uint8Array): ImageSize | typeof NEED_MORE | null {
	if (buf.length < 4) return NEED_MORE;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	// PNG: 89 50 4E 47 0D 0A 1A 0A，宽高在 IHDR 的固定偏移 16/20
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		if (buf.length < 24) return NEED_MORE;
		return { width: dv.getUint32(16), height: dv.getUint32(20) };
	}

	// GIF: "GIF"，宽高在偏移 6/8（小端）
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
		if (buf.length < 10) return NEED_MORE;
		return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
	}

	// JPEG: FF D8 开头
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		return parseJpegSize(buf);
	}

	// WEBP: "RIFF"???? "WEBP", 尺寸在 VP8 / VP8L / VP8X 各自的 chunk 头里
	if (isRiffWebp(buf)) {
		if (buf.length < 30) return NEED_MORE;
		return parseWebpSize(buf);
	}

	return null;
}

/**
 * 从完整字节解析尺寸; 解析不出或数据异常时返回 null
 *
 * 发送路径传入的是整个文件的 Buffer, NEED_MORE 在这里等价于 null(格式不支持)。
 */
export function imageScaleFromBytes(buf: Uint8Array): ImageSize | null {
	const parsed = parseImageSize(buf);
	return parsed === NEED_MORE ? null : parsed;
}

function isRiffWebp(buf: Uint8Array): boolean {
	return buf.length >= 12 &&
		buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
		buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50; // "WEBP"
}

/**
 * WEBP 子格式分发: 从偏移 12 起按 "FourCC + uint32LE size" 遍历 chunk
 *
 * - VP8X (扩展容器): 画布 w-1/h-1 为各 24bit 小端, 位于 chunk 数据偏移 4/7;
 * - VP8L (无损): 0x2f 签名后的 32bit LE 里, [0,14) 是 w-1, [14,28) 是 h-1;
 * - VP8  (有损): 3 字节 frame tag 后, 关键帧在数据偏移 6/8 给出 14bit 宽高(小端)。
 */
function parseWebpSize(buf: Uint8Array): ImageSize | typeof NEED_MORE | null {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let p = 12;
	while (p + 8 <= buf.length) {
		const fourcc = String.fromCharCode(buf[p]!, buf[p + 1]!, buf[p + 2]!, buf[p + 3]!);
		const chunkSize = dv.getUint32(p + 4, true);
		const data = p + 8;
		if (data + chunkSize > buf.length) return NEED_MORE;

		if (fourcc === "VP8X") {
			if (chunkSize < 10) return null;
			return {
				width: 1 + (buf[data + 4]! | (buf[data + 5]! << 8) | (buf[data + 6]! << 16)),
				height: 1 + (buf[data + 7]! | (buf[data + 8]! << 8) | (buf[data + 9]! << 16))
			};
		}

		if (fourcc === "VP8L") {
			if (chunkSize < 5 || buf[data] !== 0x2f) return null;
			const bits = dv.getUint32(data + 1, true);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}

		if (fourcc === "VP8 ") {
			if (chunkSize < 10) return NEED_MORE;
			// 关键帧校验: 数据偏移 3..5 固定为 9d 01 2a; 非关键帧拿不到尺寸
			if (buf[data + 3] !== 0x9d || buf[data + 4] !== 0x01 || buf[data + 5] !== 0x2a) return null;
			return {
				width: (buf[data + 6]! | ((buf[data + 7]! & 0x3f) << 8)),
				height: (buf[data + 8]! | ((buf[data + 9]! & 0x3f) << 8))
			};
		}

		// chunk 按偶数字节对齐
		p = data + chunkSize + (chunkSize % 2);
	}
	return NEED_MORE;
}

function parseJpegSize(buf: Uint8Array): ImageSize | typeof NEED_MORE | null {
	let i = 2; // 跳过 SOI (FF D8)
	while (i < buf.length) {
		// 找 marker 起始的 FF，允许连续 FF 填充
		if (buf[i] !== 0xff) { i++; continue; }
		while (i < buf.length && buf[i] === 0xff) i++;
		if (i >= buf.length) return NEED_MORE;

		const markerCode = buf[i];
		i++; // i 现在指向长度字段的高字节

		// 无长度字段的 marker: SOI(D8) / EOI(D9) / TEM(01) / RSTn(D0-D7)
		if (
			markerCode === 0xd8 || markerCode === 0xd9 || markerCode === 0x01 ||
			(markerCode! >= 0xd0 && markerCode! <= 0xd7)
		) {
			continue;
		}

		if (markerCode === 0x00) continue;

		// 其余 marker 后面跟 2 字节长度（含自身）
		if (i + 1 >= buf.length) return NEED_MORE;
		const segLen = (buf[i]! << 8) | buf[i + 1]!;
		if (segLen < 2) return null;

		// SOF marker: C0-C3 / C5-C7 / C9-CB / CD-CF
		// 排除 C4(DHT) / C8(JPG) / CC(DAC)
		if (
			markerCode! >= 0xc0 && markerCode! <= 0xcf &&
			markerCode !== 0xc4 && markerCode !== 0xc8 && markerCode !== 0xcc
		) {
			// 段内布局: len(2) precision(1) height(2) width(2) ...
			if (i + 7 > buf.length) return NEED_MORE;
			const height = (buf[i + 3]! << 8) | buf[i + 4]!;
			const width = (buf[i + 5]! << 8) | buf[i + 6]!;
			return { width, height };
		}

		// 其他段（APPn / DQT / DHT / COM 等）按长度跳过
		i += segLen;
	}
	return NEED_MORE; // 扫到尾部还没找到 SOF，说明数据不够
}
