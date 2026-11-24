/**
 * 首页仪表盘: 数值格式化工具
 */

/** 字节 → 人类可读字符串 (B/KB/MB/GB) */
export function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

/** 秒 → "Xd Xh Xm" 形式 (给「系统运行」这类不关心秒的地方用) */
export function formatUptime(sec) {
	if (!Number.isFinite(sec) || sec < 0) return "-";
	sec = Math.floor(sec);
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (d > 0) return `${d}天 ${h}小时 ${m}分`;
	if (h > 0) return `${h}小时 ${m}分`;
	if (m > 0) return `${m}分 ${s}秒`;
	return `${s}秒`;
}

/**
 * 秒 → 紧凑形式 "1d2h3min45s" (首页「已运行」用)
 *
 * 与 formatUptime 的区别: 高位的 0 值省略、秒始终保留 —— 每秒都在跳的数值
 * 用 "1小时 23分" 这种粗粒度表示会看不出它在走。
 */
export function formatUptimeShort(sec) {
	if (!Number.isFinite(sec) || sec < 0) return "-";
	sec = Math.floor(sec);
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;

	const parts = [];
	if (d > 0) parts.push(`${d}d`);
	if (d > 0 || h > 0) parts.push(`${h}h`);
	if (d > 0 || h > 0 || m > 0) parts.push(`${m}min`);
	parts.push(`${s}s`);
	return parts.join("");
}

/** 0~1 的比例 → "12.3%" (无数据时为 "—") */
export function formatPercent(ratio, digits = 1) {
	return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(digits)}%` : "—";
}
