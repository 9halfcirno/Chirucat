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

/** 秒 → "Xd Xh Xm" 形式 */
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

/** 占用率进度条颜色: 低绿 / 中黄 / 高红 */
export function barColor(ratio) {
	if (ratio < 0.6) return "#5cb85c";
	if (ratio < 0.85) return "#f0ad4e";
	return "#d9534f";
}
