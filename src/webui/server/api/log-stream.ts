import type { WebUIAPI } from "../types";
import { defaultLogStream, type LogEntry } from "../../../utils/logger";

/** 心跳间隔: 定期发送注释行, 防止代理/负载均衡器空闲断连 */
const HEARTBEAT_MS = 15_000;

/**
 * 将单条日志条目序列化为 SSE 事件文本。
 * data 只带 message (已序列化文本), 不带原始 args, 避免循环引用序列化问题。
 */
function toSSE(entry: LogEntry): string {
	const data = JSON.stringify({
		timestamp: entry.timestamp,
		time: entry.time,
		level: entry.level,
		name: entry.name,
		message: entry.message,
	});
	return `event: log\ndata: ${data}\n\n`;
}

/**
 * 日志流端点: GET /api/get_log_stream
 *
 * 连接建立后先回放 defaultLogStream 的最近历史, 再订阅实时日志推送。
 * 客户端断开时退订并清理心跳, 防止流泄漏。
 */
const api: WebUIAPI = {
	path: "get_log_stream",
	method: "GET",
	auth: true,

	stream({ res }) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no", // 禁用反向代理缓冲, 保证实时性
		});

		// 连接建立标记 + 历史回放, 让新打开的页面立即有内容
		res.write(`: connected\n\n`);
		for (const entry of defaultLogStream.getHistory()) {
			res.write(toSSE(entry));
		}

		let closed = false;
		const unsubscribe = defaultLogStream.subscribe((entry) => {
			if (closed) return;
			res.write(toSSE(entry));
		});
		const heartbeat = setInterval(() => {
			if (closed) return;
			res.write(`: heartbeat\n\n`);
		}, HEARTBEAT_MS);

		// 客户端断开 (或响应完成) 时退订并清理定时器
		res.on("close", () => {
			closed = true;
			unsubscribe();
			clearInterval(heartbeat);
		});
	},
};

export default api;
