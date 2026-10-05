import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import { ActionRouter, registerOb11Actions, type Ob11ActionDeps } from "./actions";
import type { Ob11CodecDeps } from "./codec";
import { DEFAULT_RECONNECT_INTERVAL, PLATFORM } from "./constants";
import { Ob11Connection } from "./connection";
import { buildOb11Event } from "./events";
import { ContentFilter } from "./filters";
import { IdentityCache } from "./identity";
import type { Ob11Settings, OneBotEvent } from "./types";

/**
 * OneBot11 适配器
 *
 * 通过正向 WebSocket 接入 OneBot11 实现(如 NapCat / Lagrange / LLOneBot)。
 *
 * 分工:
 * - {@link Ob11Connection} 管线路(连接/重连/API 调用)
 * - {@link buildOb11Event} 管平台 -> 框架的事件转换
 * - `actions` 管框架 -> 平台的接口调用
 *
 * 这里只做装配与生命周期, 新增能力时优先改对应模块。
 */

/** 从配置读一个字符串项 */
function readString(ctx: AdapterContext, key: string, fallback = ""): string {
	const value = ctx.config.get(key);
	return typeof value === "string" ? value.trim() : fallback;
}

/** 从配置读一个布尔项 */
function readBoolean(ctx: AdapterContext, key: string, fallback: boolean): boolean {
	const value = ctx.config.get(key, fallback);
	return typeof value === "boolean" ? value : fallback;
}

class Ob11Adapter {
	private readonly ctx: AdapterContext;
	private readonly connection: Ob11Connection;
	private readonly contentFilter: ContentFilter;
	private readonly identities = new IdentityCache();
	private readonly codec: Ob11CodecDeps;
	private readonly actionDeps: Ob11ActionDeps;

	constructor(ctx: AdapterContext) {
		this.ctx = ctx;
		const logger = ctx.logger;

		this.contentFilter = new ContentFilter(logger);

		// 平台标识双向转换: 收要向框架登记账号, 发要还原成平台 id
		this.codec = {
			resolveUserId: (platformId) => ctx.user.get(PLATFORM, platformId),
			resolvePlatformId: (userId) => {
				const info = ctx.user.query(userId);
				return info?.platform === PLATFORM ? info.id : null;
			}
		};

		this.connection = new Ob11Connection({
			logger,
			getSettings: () => this.readSettings(),
			onEvent: (event) => this.handleEvent(event)
		});

		this.actionDeps = {
			ctx,
			connection: this.connection,
			codec: this.codec,
			logger
		};
	}

	/** 注册动作处理器并开始连接 */
	start(): void {
		const router = registerOb11Actions(new ActionRouter(this.ctx.logger));

		// 处理器必须返回响应对象; ActionRouter 已保证任何路径都给出响应
		this.ctx.bot.onAction((action, extra) => router.dispatch(action, extra, this.actionDeps));

		// 连接参数变更后立即重建连接, 否则要等下一次重连(或重载插件)才生效
		this.ctx.config.watch((key) => {
			if (key === "url" || key === "accessToken") this.connection.restart();
		});

		this.connection.start();
		this.ctx.logger.log("适配器已启动");
	}

	/** 卸载: 关闭连接并释放缓存 */
	stop(): void {
		this.connection.stop();
		this.contentFilter.clear();
		this.identities.clear();
	}

	/** 记录一次运行时错误(由插件模块的 error 钩子调用) */
	reportError(e: unknown): void {
		this.ctx.logger.error(`运行时错误: ${e instanceof Error ? e.message : String(e)}`);
	}

	/** 组装连接参数; 连接与重连时都会重新读取, 使配置改动生效 */
	private readSettings(): Ob11Settings {
		const interval = Number(this.ctx.config.get("reconnectInterval", DEFAULT_RECONNECT_INTERVAL));

		return {
			url: readString(this.ctx, "url"),
			accessToken: readString(this.ctx, "accessToken"),
			reconnect: readBoolean(this.ctx, "reconnect", true),
			reconnectInterval: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_RECONNECT_INTERVAL
		};
	}

	/** 允许派发的会话类型 */
	private readSessionTypes(): string[] {
		const value = this.ctx.config.get("sessionTypes", ["private", "group"]);
		return Array.isArray(value) ? value.map(String) : ["private", "group"];
	}

	/** 平台事件 -> 框架事件 -> 派发 */
	private handleEvent(event: OneBotEvent): void {
		const built = buildOb11Event(event, {
			codec: this.codec,
			resolveSessionId: (type, platformId) => this.ctx.session.get(PLATFORM, type, platformId),
			identities: this.identities,
			selfId: this.connection.selfPlatformId,
			options: {
				sessionTypes: this.readSessionTypes(),
				atOnly: readBoolean(this.ctx, "atOnly", false),
				ignoreSelf: readBoolean(this.ctx, "ignoreSelf", true),
				contentFilter: this.contentFilter,
				contentFilterEnabled: this.ctx.config.get("contentFilter", false),
				filterRules: this.ctx.config.get("filterRules", [])
			}
		});

		// 被过滤/不支持/字段缺失: 不派发, 也不报错(实现端会持续下发各类事件)
		if (!built) return;
		this.ctx.bot.dispatch(built);
	}
}

/** 当前活动的适配器实例; 插件模块是单例, init/unload 成对调用 */
let adapter: Ob11Adapter | null = null;

export default {
	init(ctx: AdapterContext) {
		adapter = new Ob11Adapter(ctx);
		adapter.start();
	},

	unload() {
		adapter?.stop();
		adapter = null;
	},

	error(e: unknown) {
		adapter?.reportError(e);
	}
};
