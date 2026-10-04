import type { WebUIAPI } from "../types";
import Logger, { defaultLogStream, type LogEntry } from "../../../utils/logger";

const logger = new Logger("LogStream");

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
		const unsubscribe = defaultLogStream.subscribe((entry) => write(toSSE(entry)));
		const heartbeat = setInterval(() => write(`: heartbeat\n\n`), HEARTBEAT_MS);

		function cleanup(): void {
			if (closed) return;
			closed = true;
			unsubscribe();
			clearInterval(heartbeat);
		}

		// 客户端已经断开时, 对端 socket 已销毁, 再 write 会冒 error 事件;
		// 没有监听器时 Node 会把它抛成 uncaughtException, 拖崩整个进程 ——
		// 这里包住每次 write, 失败时安静收尾而不是带倒整个服务
		function write(chunk: string): void {
			if (closed) return;
			try {
				res.write(chunk);
			} catch (e) {
				logger.warn(`写入日志流失败, 连接可能已断开: ${e instanceof Error ? e.message : e}`);
				cleanup();
			}
		}

		res.on("error", (e) => {
			logger.warn(`日志流连接出错: ${e instanceof Error ? e.message : e}`);
			cleanup();
		});

		// 客户端断开 (或响应完成) 时退订并清理定时器
		res.on("close", cleanup);
	},
};

export default api;
