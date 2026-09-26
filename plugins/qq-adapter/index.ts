import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import { AccessTokenManager } from "./access";
import { ActionSender } from "./action";
import { BASE_URL } from "./config";
import { Handler } from "./handler";

// -------------------- 状态变量 --------------------
let ws: WebSocket | null = null;
let hbInterval = 30000; // 心跳间隔（毫秒）
let hbSeq: number | null = null; // 最新序列号 s
let sessionId: string | null = null; // 会话 ID（用于 Resume）

let hbTimer: NodeJS.Timeout | null = null; // 心跳周期定时器
let hbAckTimeoutTimer: NodeJS.Timeout | null = null; // 心跳响应超时定时器
let reconnectTimer: NodeJS.Timeout | null = null;

let reconnectAttempts = 0;
let isManualClose = false; // 区分主动卸载与被动断连

let ctx: AdapterContext | null = null;
let handler: Handler | null = null;
let accessManager: AccessTokenManager | null = null;
let sender: ActionSender | null = null;

// -------------------- 工具函数 --------------------
function clearAllTimers() {
	if (hbTimer) {
		clearInterval(hbTimer);
		hbTimer = null;
	}
	if (hbAckTimeoutTimer) {
		clearTimeout(hbAckTimeoutTimer);
		hbAckTimeoutTimer = null;
	}
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
}

/**
 * 安全关闭 WebSocket 连接并解绑事件
 */
function closeWebSocket(code = 1000, reason = "Closing") {
	clearAllTimers();
	if (ws) {
		const currentWs = ws;
		ws = null; // 立即置空，防止重入或后续逻辑误用
		currentWs.onopen = null;
		currentWs.onclose = null;
		currentWs.onerror = null;
		currentWs.onmessage = null;
		try {
			if (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING) {
				currentWs.close(code, reason);
			}
		} catch (_) { }
	}
}

// 计算重连延迟（指数退避，最大 30s）
function getReconnectDelay(): number {
	const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
	reconnectAttempts++;
	return delay;
}

// -------------------- 核心连接函数 --------------------
async function connect() {
	if (!ctx) {
		console.error("Context 未初始化");
		return;
	}

	// 清理旧连接与定时器
	closeWebSocket();

	// 获取最新 token
	if (!accessManager) {
		accessManager = new AccessTokenManager(ctx, ctx.config.get("app_id"), ctx.config.get("secret"));
	}
	const token = await accessManager.get();
	if (!token) {
		ctx.logger.error("获取 AccessToken 失败，停止重连");
		return;
	}

	// 获取 WebSocket 网关地址
	let wsInfo: { url: string; message?: string };
	try {
		const resp = await fetch(`${BASE_URL}/gateway`, {
			headers: { Authorization: `QQBot ${token}` }
		});
		wsInfo = await resp.json();
		if (!wsInfo.url) {
			throw new Error(wsInfo.message || "未能获取有效 Gateway URL");
		}
	} catch (e: any) {
		ctx.logger.error(`获取网关地址失败: ${e.message}`);
		scheduleReconnect();
		return;
	}

	try {
		const socket = new WebSocket(wsInfo.url);
		ws = socket;

		socket.onopen = () => {
			ctx?.logger.log("WebSocket 已建立，等待 Op 10 Hello...");
			reconnectAttempts = 0;
		};

		socket.onerror = (e) => {
			ctx?.logger.error(`WebSocket 发生错误: ${e}`);
		};

		socket.onclose = (e) => {
			ctx?.logger.warn(`WebSocket 关闭: code=${e.code}, reason=${e.reason}`);
			closeWebSocket();

			if (!isManualClose) {
				scheduleReconnect();
			}
		};

		socket.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				handleWebSocketMessage(data, token);
			} catch (e: any) {
				ctx?.logger.error(`解析 WebSocket 消息失败: ${e.message}`);
			}
		};
	} catch (e: any) {
		ctx.logger.error(`创建 WebSocket 实例失败: ${e.message}`);
		scheduleReconnect();
	}
}

// -------------------- WebSocket 消息处理 --------------------
function handleWebSocketMessage(data: any, token: string) {
	if (!ctx || !ws) return;

	const { op, d, t, s } = data;

	// 更新序列号 s
	if (s !== undefined && s !== null) {
		hbSeq = s;
	}

	// ---- Op 10: Hello（握手 & 决定鉴权方式） ----
	if (op === 10) {
		hbInterval = d?.heartbeat_interval || 30000;
		ctx.logger.log(`收到 Op 10，心跳间隔 ${hbInterval}ms`);

		// 启动心跳定时循环（不要在这里立即发 sendHeartbeat）
		startHeartbeatLoop();

		// 判别是进行会话恢复 (Resume) 还是全新鉴权 (Identify)
		if (sessionId && hbSeq !== null) {
			ctx.logger.log(`尝试会话恢复 (Resume): session_id=${sessionId}, seq=${hbSeq}`);
			const resumePayload = {
				op: 6,
				d: {
					token: `QQBot ${token}`,
					session_id: sessionId,
					seq: hbSeq
				}
			};
			ws.send(JSON.stringify(resumePayload));
		} else {
			ctx.logger.log("发起全新的鉴权 (Identify)");
			const identifyPayload = {
				op: 2,
				d: {
					token: `QQBot ${token}`,
					intents: 1 << 25, // GROUP_AND_C2C_EVENT
					shard: [0, 1],
					properties: {
						$framework: "chirucat"
					}
				}
			};
			ws.send(JSON.stringify(identifyPayload));
		}
		return;
	}

	// ---- Op 0: 事件推送 ----
	if (op === 0) {
		if (t === "READY") {
			sessionId = d?.session_id || null;
			ctx.logger.log(`鉴权成功 (READY)，Session ID: ${sessionId}`);
			return;
		}

		if (t === "RESUMED") {
			ctx.logger.log("会话恢复成功 (RESUMED)，继续接收事件");
			return;
		}

		// 普通业务事件
		if (handler) {
			handler.handle(data);
		} else {
			ctx.logger.warn("Handler 未初始化，忽略事件");
		}
		return;
	}

	// ---- Op 11: 心跳 ACK ----
	if (op === 11) {
		ctx.logger.debug("收到心跳响应 (Op 11)");
		// 收到响应，清除超时定时器
		if (hbAckTimeoutTimer) {
			clearTimeout(hbAckTimeoutTimer);
			hbAckTimeoutTimer = null;
		}
		return;
	}

	// ---- Op 7: 服务端要求重连 ----
	if (op === 7) {
		ctx.logger.warn("收到 Op 7，服务端要求重连。立即断开并恢复会话...");
		// 保留 sessionId 和 hbSeq 用于 Resume，立即主动断开并重新连接
		closeWebSocket();
		scheduleReconnect(0); // 立即重连
		return;
	}

	// ---- Op 9: 会话无效 ----
	if (op === 9) {
		const canResume = d === true;
		ctx.logger.warn(`收到 Op 9 (Invalid Session)，能否 Resume: ${canResume}`);
		if (!canResume) {
			// 无法 Resume，重置 session 状态以触发重新 Identify
			sessionId = null;
			hbSeq = null;
		}
		closeWebSocket();
		scheduleReconnect(1000);
		return;
	}

	// ---- Op 1: 服务端主动索要心跳 ----
	if (op === 1) {
		ctx.logger.log("收到 Op 1，服务端主动请求心跳，立即回复");
		sendHeartbeat();
		return;
	}
}

// -------------------- 心跳管理 --------------------
function startHeartbeatLoop() {
	if (hbTimer) clearInterval(hbTimer);
	if (hbAckTimeoutTimer) {
		clearTimeout(hbAckTimeoutTimer);
		hbAckTimeoutTimer = null;
	}

	// 仅按间隔定时发送，删掉之前的立即 sendHeartbeat()
	hbTimer = setInterval(() => {
		sendHeartbeat();
	}, hbInterval);
}

function sendHeartbeat() {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;

	const payload = JSON.stringify({
		op: 1,
		d: hbSeq
	});
	ws.send(payload);
	ctx?.logger.debug(`发送心跳 (Op 1), seq=${hbSeq}`);

	// 如果在上一个心跳周期未收到 ACK 且超时定时器还在，不重复覆盖
	if (!hbAckTimeoutTimer) {
		// 设置 10 秒超时判定（如果 10 秒内未收到 Op 11 则判定断线）
		hbAckTimeoutTimer = setTimeout(() => {
			ctx?.logger.error("心跳响应超时 (未收到 Op 11)，主动断开重连");
			closeWebSocket();
			scheduleReconnect(0);
		}, 10000);
	}
}

// -------------------- 重连调度 --------------------
function scheduleReconnect(customDelay?: number) {
	if (reconnectTimer || isManualClose) return;

	const delay = customDelay !== undefined ? customDelay : getReconnectDelay();
	ctx?.logger.log(`计划 ${delay}ms 后尝试连接 (第 ${reconnectAttempts} 次)`);

	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, delay);
}

// -------------------- 导出插件接口 --------------------
export default {
	async init(context: AdapterContext) {
		ctx = context;
		isManualClose = false;
		handler = new Handler(context);
		accessManager = new AccessTokenManager(context, ctx.config.get("app_id") ?? "", ctx.config.get("secret") ?? "");
		sender = new ActionSender(context, accessManager);

		context.bot.onAction(async (action, extra) => await sender!.send(action, extra));

		ctx.config.watch(async (key) => {
			if (key !== "app_id" && key !== "secret") return;
			if (!ctx!.config.get("app_id") || !ctx!.config.get("secret")) return;

			await accessManager!.refreshConfig(
				ctx!.config.get("app_id"),
				ctx!.config.get("secret")
			);

			// 配置变更，清空会话并完全重建
			sessionId = null;
			hbSeq = null;
			reconnectAttempts = 0;
			closeWebSocket();
			await connect();
		});

		if (!ctx.config.get("app_id") || !ctx.config.get("secret")) {
			ctx.logger.error("QQ适配器未配置 AppID / Secret，配置后会自动连接");
			return;
		}

		reconnectAttempts = 0;
		await connect();
	},

	async unload(context: AdapterContext) {
		isManualClose = true;
		clearAllTimers(); // 清理所有心跳和重连定时器
		closeWebSocket(); // 关闭 WebSocket 并解绑事件

		// 重置全局引用
		ws = null;
		handler = null;
		accessManager = null;
		sender = null;
		ctx = null;
		hbSeq = null;
		sessionId = null;
		reconnectAttempts = 0;
	}
};