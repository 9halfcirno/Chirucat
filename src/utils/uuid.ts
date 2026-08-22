// @ts-nocheck

const hexTable: string[] = [];
for (let i = 0; i < 256; i++) {
	hexTable.push((i + 0x100).toString(16).slice(1));
}

function concatUUID(buf: Uint8Array): string {
	return (
		hexTable[buf[0]] + hexTable[buf[1]] + hexTable[buf[2]] + hexTable[buf[3]] + '-' +
		hexTable[buf[4]] + hexTable[buf[5]] + '-' +
		hexTable[buf[6]] + buf[7].toString(16).padStart(2, '0') + '-' + // 确保 6-7 结合正确，或者直接查表
		hexTable[buf[8]] + hexTable[buf[9]] + '-' +
		hexTable[buf[10]] + hexTable[buf[11]] + hexTable[buf[12]] +
		hexTable[buf[13]] + hexTable[buf[14]] + hexTable[buf[15]]
	);
}


export function uuid(): string {
	// 1. 优先使用现代原生最高性能的 randomUUID
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	// 2. 其次尝试使用基于 Web Crypto 的手动字节计算
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		const buffer = new Uint8Array(16);
		crypto.getRandomValues(buffer);
		buffer[6] = (buffer[6] & 0x0f) | 0x40; // 强制设置版本为 4
		buffer[8] = (buffer[8] & 0x3f) | 0x80; // 强制设置变体
		return concatUUID(buffer);
	}

	// 3. 终极兜底方案：如果 crypto 完全不存在，直接用高效的 Math.random 配合位运算
	const fallbackBuffer = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		// Math.random() * 256 再用位或 0 快速取整，在 V8 引擎里是极快的整型操
		fallbackBuffer[i] = (Math.random() * 256) | 0;
	}
	fallbackBuffer[6] = (fallbackBuffer[6] & 0x0f) | 0x40;
	fallbackBuffer[8] = (fallbackBuffer[8] & 0x3f) | 0x80;

	return concatUUID(fallbackBuffer);

};