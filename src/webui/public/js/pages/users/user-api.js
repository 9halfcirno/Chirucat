/**
 * 用户管理各子页共用的请求与格式化工具
 */
// 通用请求封装在 spa 层, 这里只做转发, 让子页从一个地方取工具
export { callAPI } from "../../spa/api.js";

/** 短 id: 完整值放在 title 里 */
export function shortId(id) {
	const text = String(id ?? "");
	return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}

/** 数字千分位 */
export function fmt(n) {
	return typeof n === "number" ? n.toLocaleString("zh-CN") : "-";
}

/** 时间戳 -> 本地短时间; 空值显示 "-" */
export function fmtTime(ms) {
	if (!ms) return "-";
	return new Date(ms).toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}
