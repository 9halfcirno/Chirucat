import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import { AccessTokenManager } from "./access";
import { ActionRouter, registerQQActions, SeqAllocator, type QQActionDeps } from "./actions";
import { QQApi } from "./api";
import { INTENTS, PLATFORM } from "./config";
import { QQConnection } from "./connection";
import { buildQQEvent } from "./events";
import type { QQWebSocketPayload } from "./types";
import { MediaUploader } from "./uploader";

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

class QQAdapter {
	private readonly ctx: AdapterContext;
	private readonly access: AccessTokenManager;
	private readonly api: QQApi;
	private readonly uploader: MediaUploader;
	private readonly router: ActionRouter;
	private readonly actionDeps: QQActionDeps;
	private readonly connection: QQConnection;

	constructor(ctx: AdapterContext) {
		this.ctx = ctx;
		const logger = ctx.logger;

		this.access = new AccessTokenManager(logger, readString(ctx, "app_id"), readString(ctx, "secret"));
		this.api = new QQApi(this.access, logger);
		this.uploader = new MediaUploader(this.api, logger);
		this.router = registerQQActions(new ActionRouter(logger));
		this.actionDeps = {
			ctx,
			api: this.api,
			uploader: this.uploader,
			logger,
			seq: new SeqAllocator()
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

		this.connection.start();
	}

	/** 卸载: 关闭连接并清理全部定时器 */
	stop(): void {
		this.connection.stop();
	}

	/** 平台事件 -> 框架事件 -> 派发 */
	private handleEvent(payload: QQWebSocketPayload): void {
		const event = buildQQEvent(payload, {
			resolveUserId: (platformId) => this.ctx.user.get(PLATFORM, platformId),
			resolveSessionId: (type, platformId) => this.ctx.session.get(PLATFORM, type, platformId)
		});

		// 未知事件类型或缺少关键字段: 不派发, 也不报错(平台会持续下发各类事件)
		if (!event) return;
		this.ctx.bot.dispatch(event);
	}

	/**
	 * 凭据变更后重建连接
	 *
	 * 必须走 restart 而不是普通重连: 旧 session 属于旧 Bot, 继续 RESUME 会一直被拒。
	 */
	private async onConfigChange(key: string): Promise<void> {
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
		adapter.start();
	},

	async unload() {
		adapter?.stop();
		adapter = null;
	}
};
