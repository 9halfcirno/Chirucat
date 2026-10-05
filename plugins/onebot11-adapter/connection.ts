import type Logger from "../../src/utils/logger";
import { API_TIMEOUT, DEFAULT_RECONNECT_INTERVAL } from "./constants";
import type { Ob11Settings, OneBotApiRequest, OneBotApiResponse, OneBotEvent } from "./types";

/**
 * 正向 WebSocket 连接
 *
 * 负责与 OneBot11 实现端的全部线路交互: 连接/重连、下行事件分拣、以及
 * 通过 `echo` 关联请求与响应的 API 调用。
 *
 * 上行消息的解析不在这里 —— 分拣后的事件通过 {@link Ob11ConnectionOptions.onEvent}
 * 交出去, 因此本类只关心"线路", 便于单独替换(如将来支持反向 WS)。
 */

/** 一次等待响应的 API 调用 */
type PendingCall = {
	resolve: (value: any) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
};

export interface Ob11ConnectionOptions {
	logger: Logger;
	/** 读取连接参数; 每次连接时调用, 使配置改动能在下一次连接生效 */
	getSettings: () => Ob11Settings;
	/** 事件回调(已排除 API 响应与元事件) */
	onEvent: (event: OneBotEvent) => void;
}

export class Ob11Connection {
	private socket: WebSocket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;

	/** 已请求停止: 之后不再重连 */
	private stopped = true;
	/** 正在建立连接, 防止并发 connect */
	private connecting = false;

	private echoSeq = 0;
	/** 机器人自身平台 id, 来自元事件或消息事件 */
	private selfId: string | null = null;
	/** 未收到响应的 API 调用 */
	private pending = new Map<string, PendingCall>();

	constructor(private readonly options: Ob11ConnectionOptions) { }

	/** 机器人自身平台 id, 未知时为 null */
	get selfPlatformId(): string | null {
		return this.selfId;
	}

	/** 开始连接并进入自动重连循环 */
	start(): void {
		this.stopped = false;
		this.connect();
	}

	/** 停止: 关闭连接、清理定时器、拒绝所有在途调用, 之后不再重连 */
	stop(): void {
		this.stopped = true;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		this.failAllPending("适配器已卸载");
		this.closeSocket();
		this.selfId = null;
	}

	/**
	 * 用最新配置重建连接
	 *
	 * 连接参数(地址/令牌)变更后调用: 只靠"下次重连"是不够的 —— 当前连接还活着时
	 * 根本不会有下次重连, 用户会以为配置没生效。
	 */
	restart(): void {
		if (this.stopped) return;

		this.closeSocket();
		this.failAllPending("连接参数已变更");

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		this.connect();
	}

	/**
	 * 调用 OneBot API
	 *
	 * 通过 `echo` 与响应配对; 超时或连接关闭时 reject。
	 * @param action API 名, 如 `send_group_msg`
	 * @param params 调用参数
	 */
	callApi<T = any>(action: string, params: Record<string, unknown>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const socket = this.socket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				reject(new Error("OneBot 连接未就绪"));
				return;
			}

			const echo = `chirucat-${Date.now()}-${++this.echoSeq}`;
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				reject(new Error(`OneBot API 超时: ${action}`));
			}, API_TIMEOUT);

			this.pending.set(echo, { resolve, reject, timer });

			const request: OneBotApiRequest = { action, params, echo };
			try {
				socket.send(JSON.stringify(request));
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(echo);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	// -------------------- 连接 --------------------

	private connect(): void {
		if (this.stopped || this.connecting) return;
		this.connecting = true;

		try {
			this.closeSocket();

			const settings = this.options.getSettings();

			if (!settings.url) {
				this.options.logger.error("未配置 WebSocket 地址, 跳过连接");
				return;
			}

			let url: URL;
			try {
				url = new URL(settings.url);
			} catch {
				this.options.logger.error(`非法的 WebSocket 地址: ${settings.url}`);
				return;
			}

			if (settings.accessToken) url.searchParams.set("access_token", settings.accessToken);

			let socket: WebSocket;
			try {
				socket = new WebSocket(url.toString());
			} catch (e) {
				this.options.logger.error(`创建连接失败: ${errorMessage(e)}`);
				this.scheduleReconnect();
				return;
			}

			this.socket = socket;
			this.options.logger.log(`正在连接 ${url.origin}${url.pathname}`);

			socket.onopen = () => {
				if (this.socket !== socket) return;
				this.options.logger.log("连接已建立");
			};

			socket.onmessage = (event) => {
				if (this.socket !== socket) return;
				this.handleRaw(event.data);
			};

			socket.onerror = () => {
				if (this.socket !== socket) return;
				this.options.logger.warn("WebSocket 发生错误");
			};

			socket.onclose = (event) => {
				if (this.socket !== socket) return;
				this.closeSocket();
				this.failAllPending("OneBot 连接已关闭");
				this.options.logger.warn(`连接已关闭 (code=${event.code})`);
				this.scheduleReconnect();
			};
		} finally {
			this.connecting = false;
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;

		const settings = this.options.getSettings();
		if (!settings.reconnect) {
			this.options.logger.log("自动重连已关闭");
			return;
		}

		const delay = settings.reconnectInterval > 0 ? settings.reconnectInterval : DEFAULT_RECONNECT_INTERVAL;
		this.options.logger.log(`${delay}ms 后尝试重连`);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	// -------------------- 下行 --------------------

	private handleRaw(raw: unknown): void {
		let data: OneBotEvent;
		try {
			data = JSON.parse(typeof raw === "string" ? raw : String(raw)) as OneBotEvent;
		} catch {
			this.options.logger.warn("收到非 JSON 数据, 已忽略");
			return;
		}

		if (!data || typeof data !== "object") return;

		// API 调用响应: 带 echo 即为响应
		if ("echo" in data) {
			this.resolveCall(data as OneBotApiResponse);
			return;
		}

		// 元事件与消息事件都可能携带 self_id, 见到就记下来
		const selfId = (data as { self_id?: unknown }).self_id;
		if (selfId !== undefined && selfId !== null) this.selfId = String(selfId);

		// 元事件(心跳/生命周期)只是线路保活, 不构成框架事件
		if ((data as { post_type?: unknown }).post_type === "meta_event") return;

		this.options.onEvent(data);
	}

	private resolveCall(response: OneBotApiResponse): void {
		const echo = String(response.echo);
		const pending = this.pending.get(echo);
		if (!pending) return;

		this.pending.delete(echo);
		clearTimeout(pending.timer);

		// 不同实现用 status 或 retcode 表达成功, 两者都认
		const ok = response.status === "ok" || response.retcode === 0;
		if (ok) {
			pending.resolve(response.data);
			return;
		}

		const detail = response.message ?? response.msg ?? response.wording ?? "";
		pending.reject(new Error(`OneBot API 错误 (retcode=${response.retcode}): ${detail}`));
	}

	private failAllPending(reason: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = null;
		if (!socket) return;

		// 先解绑再关闭: onclose 里会触发重连, 卸载/重建时不该被它干扰
		socket.onopen = null;
		socket.onclose = null;
		socket.onerror = null;
		socket.onmessage = null;

		try {
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close(1000, "closing");
			}
		} catch {
			// 连接已丢弃, 关闭失败无需处理
		}
	}
}

/** 统一取错误文本 */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
