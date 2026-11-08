import path from "node:path";
import type { Bot } from "../../bot/bot";
import type { Entity } from "../../entity/entity";
import { StateError } from "../../errors/state-error";
import type { BotActions } from "../../protocols/actions";
import { root } from "../../utils/root";
import { PluginExports } from "../exports";
import { ManagedContextBase } from "../managed-context";
import type { Plugin } from "../plugin";
import type {
	PluginBotAPI,
	PluginSessionAPI,
	PluginUserAPI,
} from "./types";

/**
 * 普通插件运行上下文
 *
 * 日志、消息回调、平台事件订阅、指令登记、配置与 KV 生命周期、释放流程都在
 * `ManagedContextBase`; 这里只放"属于某个 Bot"的域能力: 当前 Bot 的只读视图、
 * 用户/会话查询、动作转发, 以及本 Bot 插件间的导入导出与适配器逃生舱。
 */
export class PluginContext extends ManagedContextBase {
	protected _bot: Bot;

	/** 本上下文发布的适配器逃生舱导出 (见 AdapterContext) */
	protected readonly _adapterExports: PluginExports;

	/** 当前 Bot 的只读视图 */
	bot: PluginBotAPI;

	/** 用户标识: 只查不建, 账号落账由适配器负责 */
	user: PluginUserAPI = {
		find: (platform, id) => {
			return this._bot.core.user!.find(platform, id);
		},
		query: (uuid) => {
			return this._bot.core.user!.query(uuid);
		},
		getUnion: (accountId) => {
			return this._bot.core.user!.getUnion(accountId);
		},
	};

	/** 会话标识: 只查不建, 会话落账由适配器负责 */
	session: PluginSessionAPI = {
		find: (platform, type, id) => {
			return this._bot.core.session!.find(platform, type, id);
		},
		query: (uuid) => {
			return this._bot.core.session!.query(uuid);
		},
	};

	constructor(
		plugin: Plugin,
		exports: PluginExports,
		serviceExports: PluginExports | null = null,
		adapterExports: PluginExports = new PluginExports(),
	) {
		super({
			manifest: plugin.manifest,
			loggerName: "Plugin",
			tag: plugin.bot.id,
			// bot.path 为绝对路径, resolve 会从其重置; 若为相对路径则以 root 为基准
			storageRoot: path.resolve(root, plugin.bot.path, "data", "plugins", plugin.manifest.id),
			config: plugin.config,
			ownExports: exports,
			serviceExports,
			commands: plugin.bot.command,
			cron: () => plugin.bot.core.cron,
		});

		this._bot = plugin.bot;
		this._adapterExports = adapterExports;

		this.bot = {
			id: this._bot.id,
			name: this._bot.name,
		};
	}

	/**
	 * 触发Bot动作
	 * @param entity 事件实体
	 * @param action 动作对象
	 */
	action(entity: Entity, action: BotActions) {
		this.assertAlive("发送Action");
		return this._bot.action(action, entity.meta.adapter, entity.extra);
	}

	/**
	 * 导入bot加载的其他插件的导出
	 *
	 * 每次调用实时查询注册表, 因此不要在插件里缓存返回值 ——
	 * 目标插件卸载后其导出即被释放, 缓存下来只会拿到已失效的对象。
	 * @param pluginId 导入插件的id
	 * @throws 目标插件当前没有导出(未加载/未导出/已卸载)时抛出 StateError
	 */
	require<T = any>(pluginId: string): T {
		if (this._ownExports.hasExports(pluginId)) {
			return this._ownExports.getExports(pluginId) as T;
		}

		// 适配器的导出不进 require 注册表: 它发布在逃生舱注册表, 按事件来源取用
		const target = this._bot.plugin.enabledPlugins
			.find(p => p.id === pluginId && p.manifest.type === "adapter");
		if (target) {
			throw new StateError(
				`插件 ${this._manifest.id} 导入失败: 插件 ${pluginId} 是适配器, ` +
				`其导出走逃生舱注册表, 请经 Entity.escape() / ctx.adapterEscape("${pluginId}") 取用, 或订阅 ctx.onPlatformEvent("${pluginId}", ...)`
			);
		}

		const available = [...this._ownExports.ids()];
		throw new StateError(
			`插件 ${this._manifest.id} 导入失败: 插件 ${pluginId} 当前没有导出` +
			(available.length ? `(当前可导入: ${available.join(", ")})` : "(当前没有任何插件提供导出)")
		);
	}

	/**
	 * 取适配器发布的逃生舱导出(与 `Entity.escape` 同一注册表, 不要求手头有实体)
	 *
	 * 纯平台事件通路(见 `onPlatformEvent`)里消费者只有 `event + meta`,
	 * 用 `ctx.adapterEscape(meta.adapter)` 闭环。每次调用实时查询, 不要缓存返回值 ——
	 * 适配器卸载后条目即被释放。未发布逃生舱时返回 null, 调用方自行降级。
	 * @param adapterId 适配器插件id
	 */
	adapterEscape<T = any>(adapterId: string): T | null {
		return this._adapterExports.getExports(adapterId) ?? null;
	}

	/** 释放导出: 本插件的 require 条目 + 逃生舱注册表里的发布(通常为空条目) */
	protected releaseOwned(): void {
		this._ownExports.releaseExports(this._manifest.id, this);
		this._adapterExports.releaseExports(this._manifest.id, this);
	}
}
