import type Logger from "../../src/utils/logger";
import {
	BASE_URL,
	DEFAULT_HEARTBEAT_INTERVAL,
	HEARTBEAT_ACK_TIMEOUT,
	INTENTS,
	MAX_RECONNECT_DELAY,
	REQUEST_TIMEOUT
} from "./config";
import type { QQGatewayInfo, QQReadyData, QQWebSocketPayload } from "./types";

/** 网关操作码 */
export const OP = {
	/** 事件推送 */
	EVENT: 0,
	/** 客户端心跳 */
	HEARTBEAT: 1,
	/** 首次鉴权 */
	IDENTIFY: 2,
	/** 恢复会话 */
	RESUME: 6,
	/** 服务端要求重连 */
	RECONNECT: 7,
	/** 会话无效 */
	INVALID_SESSION: 9,
	/** 握手, 下发心跳间隔 */
	HELLO: 10,
	/** 心跳响应 */
	HEARTBEAT_ACK: 11
} as const;

export interface QQConnectionOptions {
	/** 取可用 AccessToken; 返回 null 表示暂不可用, 交由重连调度重试 */
	getToken: () => Promise<string | null>;
	logger: Logger;
	/** 业务事件回调(op=0 且非 READY/RESUMED) */
	onEvent: (payload: QQWebSocketPayload) => void;
	/** 订阅的意图位, 缺省为 {@link INTENTS} */
	intents?: number;
}

/**
 * QQ 网关连接
 *
 * 负责协议层的一切: 握手、鉴权/会话恢复、心跳与 ACK 超时、断线重连。
 * 业务事件解析不在这里 —— 它通过 {@link QQConnectionOptions.onEvent} 交出去。
 *
 * 之所以做成类而不是模块级全局量: 连接状态(ws/seq/session/定时器)是一份完整的
 * 生命周期状态, 挂在实例上可以整体创建/销毁, `stop()` 后不会留下残留定时器,
 * 也便于将来做多分片(shard)或同时管理多个连接。
 */
export class QQConnection {
	private ws: WebSocket | null = null;
	/** 建立连接时使用的 token, 鉴权/恢复会话都要原样带上 */
	private token: string | null = null;

	/** 心跳间隔(ms), 以 Op 10 下发的值为准 */
	private heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL;
	/** 最新序列号, 用于 RESUME */
	private seq: number | null = null;
	/** 会话 id, 仅 RESUME 时使用 */
	private sessionId: string | null = null;

	private heartbeatTimer: NodeJS.Timeout | null = null;
	private ackTimer: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;

	/** 连续重连次数, 用于指数退避 */
	private attempts = 0;
	/** 已请求停止: 之后不再重连 */
	private stopped = false;
	/** 正在建立连接, 防止并发 connect */
	private connecting = false;

	constructor(private readonly options: QQConnectionOptions) { }

	/** 启动并进入自动重连循环 */
	start(): void {
		this.stopped = false;
		void this.connect();
	}

	/** 停止连接: 关闭 socket、清理全部定时器, 之后不再重连 */
	stop(): void {
		this.stopped = true;
		this.resetTimers();
		this.closeSocket();
		this.sessionId = null;
		this.seq = null;
		this.attempts = 0;
	}

	/**
	 * 重置会话并立即重建连接
	 *
	 * 用于凭据变更: 必须丢掉旧 session(它属于旧 Bot), 否则 RESUME 会失败。
	 */
	async restart(): Promise<void> {
		this.stopped = false;
		this.sessionId = null;
		this.seq = null;
		this.attempts = 0;
		this.resetTimers();
		this.closeSocket();
		await this.connect();
	}

	// -------------------- 连接建立 --------------------
	private async connect(): Promise<void> {
		if (this.stopped || this.connecting) return;
		this.connecting = true;

		try {
			this.resetTimers();
			this.closeSocket();

			const token = await this.options.getToken();
			if (this.stopped) return;

			if (!token) {
				this.options.logger.error("获取 AccessToken 失败, 稍后重试");
				this.scheduleReconnect();
				return;
			}
			this.token = token;

			const gateway = await this.fetchGateway(token);
			if (this.stopped) return;

			if (!gateway) {
				this.scheduleReconnect();
				return;
			}

			this.openSocket(gateway);
		} finally {
			this.connecting = false;
		}
	}

	/** 取网关地址 */
	private async fetchGateway(token: string): Promise<string | null> {
		try {
			const response = await fetch(`${BASE_URL}/gateway`, {
				headers: { Authorization: `QQBot ${token}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT)
			});

			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const info = await response.json() as QQGatewayInfo;
			if (!info?.url) throw new Error(info?.message || "响应缺少 url");
			return info.url;
		} catch (e) {
			this.options.logger.error(`获取网关地址失败: ${errorMessage(e)}`);
			return null;
		}
	}

	private openSocket(url: string): void {
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (e) {
			this.options.logger.error(`创建 WebSocket 失败: ${errorMessage(e)}`);
			this.scheduleReconnect();
			return;
		}

		this.ws = socket;

		socket.onopen = () => {
			if (this.ws !== socket) return;
			this.options.logger.log("WebSocket 已建立, 等待 Op 10 Hello");
			// 连上就算一次成功的重连, 重置退避
			this.attempts = 0;
		};

		socket.onerror = () => {
			if (this.ws !== socket) return;
			this.options.logger.warn("WebSocket 发生错误");
		};

		socket.onclose = (event) => {
			if (this.ws !== socket) return;
			this.closeSocket();
			this.resetTimers();
			this.options.logger.warn(`WebSocket 关闭: code=${event.code}, reason=${event.reason}`);
			this.scheduleReconnect();
		};

		socket.onmessage = (event) => {
			if (this.ws !== socket) return;
			this.handleRawMessage(event.data);
		};
	}

	// -------------------- 下行处理 --------------------

	private handleRawMessage(raw: unknown): void {
		let payload: QQWebSocketPayload;
		try {
			payload = JSON.parse(typeof raw === "string" ? raw : String(raw)) as QQWebSocketPayload;
		} catch (e) {
			this.options.logger.error(`解析 WebSocket 消息失败: ${errorMessage(e)}`);
			return;
		}

		if (!payload || typeof payload !== "object") return;
		if (typeof payload.s === "number") this.seq = payload.s;

		switch (payload.op) {
			case OP.HELLO:
				this.onHello(payload.d);
				return;
			case OP.EVENT:
				this.onEvent(payload);
				return;
			case OP.HEARTBEAT_ACK:
				this.clearAckTimer();
				this.options.logger.debug("收到心跳响应 (Op 11)");
				return;
			case OP.RECONNECT:
				// 保留 sessionId/seq 以便 RESUME, 立即主动断开重连
				this.options.logger.warn("服务端要求重连 (Op 7), 立即断开并恢复会话");
				this.closeSocket();
				this.scheduleReconnect(0);
				return;
			case OP.INVALID_SESSION: {
				// Op 9 的 d 是布尔值(能否 Resume), 与其它 Op 的对象体不同
				const canResume = (payload.d as unknown) === true;
				this.options.logger.warn(`会话无效 (Op 9), 能否 Resume: ${canResume}`);
				if (!canResume) {
					// 无法恢复: 清掉会话状态, 下次走全新 Identify
					this.sessionId = null;
					this.seq = null;
				}
				this.closeSocket();
				this.scheduleReconnect(1_000);
				return;
			}
			case OP.HEARTBEAT:
				this.options.logger.debug("服务端主动索要心跳 (Op 1), 立即回复");
				this.sendHeartbeat();
				return;
			default:
				this.options.logger.debug(`忽略未知 Op: ${payload.op}`);
		}
	}

	/** Op 10: 握手完成后决定 Resume 还是 Identify */
	private onHello(d: Record<string, any> | undefined): void {
		const interval = Number(d?.heartbeat_interval);
		this.heartbeatInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_HEARTBEAT_INTERVAL;
		this.options.logger.log(`收到 Op 10 Hello, 心跳间隔 ${this.heartbeatInterval}ms`);

		this.startHeartbeatLoop();

		if (this.sessionId && this.seq !== null) {
			this.options.logger.log(`尝试会话恢复 (Resume): session_id=${this.sessionId}, seq=${this.seq}`);
			this.send({
				op: OP.RESUME,
				d: { token: `QQBot ${this.token}`, session_id: this.sessionId, seq: this.seq }
			});
			return;
		}

		this.options.logger.log("发起全新鉴权 (Identify)");
		this.send({
			op: OP.IDENTIFY,
			d: {
				token: `QQBot ${this.token}`,
				intents: this.options.intents ?? INTENTS,
				shard: [0, 1],
				properties: { $framework: "chirucat" }
			}
		});
	}

	/** Op 0: READY/RESUMED 属于连接层, 其余交给业务回调 */
	private onEvent(payload: QQWebSocketPayload): void {
		if (payload.t === "READY") {
			const sessionId = (payload.d as QQReadyData | undefined)?.session_id;
			this.sessionId = sessionId ?? null;
			this.options.logger.log(`鉴权成功 (READY), session=${this.sessionId}`);
			return;
		}

		if (payload.t === "RESUMED") {
			this.options.logger.log("会话恢复成功 (RESUMED), 继续接收事件");
			return;
		}

		this.options.onEvent(payload);
	}

	// -------------------- 心跳 --------------------

	private startHeartbeatLoop(): void {
		this.clearHeartbeatTimer();
		// 只按间隔定时发送: 握手后立刻发一次会和平台的 ACK 判定打架
		this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval);
	}

	private sendHeartbeat(): void {
		const socket = this.ws;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;

		try {
			socket.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
		} catch (e) {
			this.options.logger.error(`发送心跳失败: ${errorMessage(e)}`);
			return;
		}

		this.options.logger.debug(`发送心跳 (Op 1), seq=${this.seq}`);

		// 上一轮的超时判定还在等待时不重复覆盖, 否则超时会被无限推迟
		if (this.ackTimer) return;

		this.ackTimer = setTimeout(() => {
			this.ackTimer = null;
			this.options.logger.error("心跳响应超时 (未收到 Op 11), 主动断开重连");
			this.resetTimers();
			this.closeSocket();
			this.scheduleReconnect(0);
		}, HEARTBEAT_ACK_TIMEOUT);
	}

	// -------------------- 重连 --------------------

	private scheduleReconnect(customDelay?: number): void {
		if (this.stopped || this.reconnectTimer) return;

		const delay = customDelay ?? this.nextBackoff();
		this.options.logger.log(`计划 ${delay}ms 后重连 (已尝试 ${this.attempts} 次)`);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect();
		}, delay);
	}

	/** 指数退避: 1s, 2s, 4s ... 上限 {@link MAX_RECONNECT_DELAY} */
	private nextBackoff(): number {
		const delay = Math.min(1_000 * Math.pow(2, this.attempts), MAX_RECONNECT_DELAY);
		this.attempts++;
		return delay;
	}

	// -------------------- 工具 --------------------

	/** 发送一个数据包; socket 不可用或无 token 时静默放弃 */
	private send(payload: Record<string, unknown>): void {
		const socket = this.ws;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;

		try {
			socket.send(JSON.stringify(payload));
		} catch (e) {
			this.options.logger.error(`发送数据包失败: ${errorMessage(e)}`);
		}
	}

	/** 解绑事件并关闭 socket */
	private closeSocket(): void {
		const socket = this.ws;
		this.ws = null;
		if (!socket) return;

		socket.onopen = null;
		socket.onclose = null;
		socket.onerror = null;
		socket.onmessage = null;

		try {
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close(1000, "closing");
			}
		} catch {
			// 关闭失败无需处理: socket 已被丢弃, 后续由 GC 回收
		}
	}

	private resetTimers(): void {
		this.clearHeartbeatTimer();
		this.clearAckTimer();

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private clearHeartbeatTimer(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private clearAckTimer(): void {
		if (this.ackTimer) {
			clearTimeout(this.ackTimer);
			this.ackTimer = null;
		}
	}
}

/** 统一取错误文本 */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
