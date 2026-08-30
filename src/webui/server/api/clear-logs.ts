import type { WebUIAPI } from "../types";
import { defaultLogStream } from "../../../utils/logger";

/**
 * 清理日志: POST /api/clear_logs
 *
 * 清空 defaultLogStream 的历史缓冲（供新连接回放的旧日志）。
 * 已连接的 SSE 日志流不受影响, 后续新日志继续实时推送。
 */
const api: WebUIAPI = {
	path: "clear_logs",
	method: "POST",
	auth: true,

	handler() {
		defaultLogStream.clear();
		return { ok: true };
	},
};

export default api;
