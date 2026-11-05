import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import { AccessTokenManager } from "./access";
import { ActionRouter, registerQQActions, SeqAllocator, SessionSendGate, type QQActionDeps } from "./actions";
import { QQApi } from "./api";
import { INTENTS, PLATFORM } from "./config";
import { QQConnection } from "./connection";
import { buildQQEvent, MESSAGE_ROUTES } from "./events";
import { parseMessageTime, PassiveReplyWindow } from "./passive-window";
import type { QQWebSocketPayload } from "./types";
import { MediaUploader } from "./uploader";
import { ImageMaterialCache } from "./image-cache";

/**
 * QQ 适配器
 *
 * 分工:
 * - {@link QQConnection} 管协议层(握手/心跳/重连)
 * - {@link buildQQEvent} 管平台 -> 框架的事件转换
 * - {@link ActionRouter} + `actions` 管框架 -> 平台的接口调用
 *
 * 这里只做装配与生命周期, 因此新增能力时优先改对应模块, 而不是往本文件堆逻辑。
 */

/** 从配置读一个字符串项 */
function readString(ctx: AdapterContext, key: string): string {
	const value = ctx.config.get(key);
	return typeof value === "string" ? value.trim() : "";
}

/** 从配置读一个整数项, 非法值取 default */
function readInt(ctx: AdapterContext, key: string, fallback: number): number {
	const value = ctx.config.get<number>(key, fallback);
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

class QQAdapter {
	private readonly ctx: AdapterContext;
	private readonly access: AccessTokenManager;
	/** 逃生舱的 request 通道要用; 仅在本文件内消费, 不外传实例 */
	readonly api: QQApi;
	private readonly uploader: MediaUploader;
	private readonly imageCache: ImageMaterialCache;
	private readonly router: ActionRouter;
	private readonly actionDeps: QQActionDeps;
	private readonly connection: QQConnection;
	/** msg_id -> 消息发送时间, 决定回复能否走被动窗口 */
	private readonly passiveWindow: PassiveReplyWindow;

	constructor(ctx: AdapterContext) {
		this.ctx = ctx;
		const logger = ctx.logger;

		this.access = new AccessTokenManager(logger, readString(ctx, "app_id"), readString(ctx, "secret"));
		this.api = new QQApi(this.access, logger);
		this.uploader = new MediaUploader(this.api, logger);
		// 图片素材缓存: 请求与 KV 复用适配器现有通道; init 幂等, acceptor 等插件也这么调
		this.ctx.kv.init();
		this.imageCache = new ImageMaterialCache({
			request: (method, path, body, timeout) => this.api.request(method, path, body, timeout),
			kv: this.ctx.kv,
			logger,
			maxEntries: readInt(ctx, "material.max_entries", 100)
		});
		this.router = registerQQActions(new ActionRouter(logger));
		this.passiveWindow = new PassiveReplyWindow();
		this.actionDeps = {
			ctx,
			api: this.api,
			uploader: this.uploader,
			logger,
			seq: new SeqAllocator(),
			gate: new SessionSendGate(),
			msgWindow: this.passiveWindow,
			imageCache: this.imageCache
		};

		this.connection = new QQConnection({
			logger,
			intents: INTENTS,
			getToken: () => this.access.get(),
			onEvent: (payload) => this.handleEvent(payload)
		});
	}

	/** 注册动作处理器与配置监听, 并开始连接 */
	start(): void {
		// 处理器必须返回响应对象; ActionRouter 已保证任何路径都给出响应
		this.ctx.bot.onAction((action, extra) => this.router.dispatch(action, extra, this.actionDeps));

		this.ctx.config.watch((key) => {
			void this.onConfigChange(key);
		});

		if (!readString(this.ctx, "app_id") || !readString(this.ctx, "secret")) {
			this.ctx.logger.error("QQ适配器未配置 AppID / Secret, 配置后会自动连接");
			return;
		}

		// 冷启动重建素材 LRU: 失败只降级为按需上传(internal 已记日志), 不阻塞连接
		void this.imageCache.warmUp();

		this.connection.start();
	}

	/** 卸载: 关闭连接并清理全部定时器 */
	stop(): void {
		this.connection.stop();
		this.passiveWindow.destroy();
	}

	/** 平台事件 -> 框架事件 -> 派发; 未建模的事件类型原样转发给逃生舱订阅者 */
	private handleEvent(payload: QQWebSocketPayload): void {
		const event = buildQQEvent(payload, {
			resolveUserId: (platformId) => this.ctx.user.get(PLATFORM, platformId),
			resolveSessionId: (type, platformId) => this.ctx.session.get(PLATFORM, type, platformId)
		});

		// 未知事件类型: 交给逃生舱(平台会持续下发各类事件, 好友/群组变更等不在框架协议内);
		// 已建模但缺关键字段的属于残缺事件, 按协议约定丢弃, 不转发
		if (!event) {
			if (payload.t && !MESSAGE_ROUTES[payload.t]) {
				this.ctx.bot.dispatchPlatformEvent(payload);
			}
			return;
		}

		// 登记被动回复窗口: 窗口从平台的发送时间算起, 不能只从本地收到时间算
		if (event.messageId) {
			this.passiveWindow.remember(event.messageId, parseMessageTime(event.source?.timestamp));
		}

		this.ctx.bot.dispatch(event);
	}

	/**
	 * 配置变更响应
	 *
	 * - app_id/secret: 必须重建连接(旧 session 属于旧 Bot, 继续 RESUME 会一直被拒);
	 * - material.max_entries: 热更新素材上限(只影响后续淘汰, 不立即删素材);
	 * - material.mixed_markdown: 发送时现读, 无需接通知。
	 */
	private async onConfigChange(key: string): Promise<void> {
		if (key === "material.max_entries") {
			this.imageCache.setMaxEntries(readInt(this.ctx, "material.max_entries", 100));
			return;
		}
		if (key !== "app_id" && key !== "secret") return;

		const appId = readString(this.ctx, "app_id");
		const secret = readString(this.ctx, "secret");
		if (!appId || !secret) return;

		try {
			await this.access.reset(appId, secret);
			await this.connection.restart();
		} catch (e) {
			// 配置写错不该变成未捕获的 rejection: 记录下来, 交给重连调度再试
			const msg = e instanceof Error ? e.message : String(e);
			this.ctx.logger.error(`配置变更后重建连接失败: ${msg}`);
		}
	}
}

/** 当前活动的适配器实例; 插件模块是单例, init/unload 成对调用 */
let adapter: QQAdapter | null = null;

export default {
	async init(ctx: AdapterContext) {
		adapter = new QQAdapter(ctx);

		// 逃生舱: 发布适配器私有能力面(未建模事件的原始流在 handleEvent 转发)。
		// 在 start 之前发布 —— 缺凭据时 start 会早退不连接, 但 HTTP 通道与事件字段
		// 解析不依赖连接, 消费端应能照常取用。
		ctx.exports = {
			/** 原始 REST 通道: 任意 QQ 开放平台接口, 返回值由 QQApi 解析(失败抛 QQApiError) */
			request: <T = unknown>(
				method: "GET" | "POST" | "PUT" | "DELETE",
				path: string,
				body?: unknown,
				timeoutMs?: number
			): Promise<T> => adapter!.api.request<T>(method, path, body, timeoutMs),
			/** 本 Bot 的 QQ 平台 id(app_id), 供消费端换算框架账号 */
			selfPlatformId: (): string => readString(ctx, "app_id")
		};

		adapter.start();
	},

	async unload() {
		adapter?.stop();
		adapter = null;
	}
};
