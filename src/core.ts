import path from "path";
import { BotManager } from "./bot/manager";
import { BotHelper } from "./helpers/bot-helper";
import { UserManager } from "./internal/user-manager";
import { root } from "./utils/root";
import { SessionManager } from "./internal/session-manager";
import type { CoreOption } from "./types";
import Logger from "./utils/logger";
import { dirCheck } from "./utils/dir-check";
import type { StatisticsManager } from "./statistics/manager";
import type { WebUIServer } from "./webui/server/server";
import sqlite from "better-sqlite3";
import { UserProfileManager } from "./internal/user-profile";
import { FilterListManager } from "./internal/filter-list";
import { ServiceHost } from "./plugin/services/host";

const logger = new Logger("Core")

export class Core {
	private _disposed: boolean = false;
	config: CoreOption = {
		webui: true,
	};
	bot = new BotManager(this);
	botHelper = new BotHelper(this);
	/** 服务插件宿主: services/ 下的框架级插件, 全局单例, 生命周期由 Core 管理 */
	services = new ServiceHost(this);

	private internalDB: sqlite.Database | null = null;
	user: UserManager | null = null;
	/** 用户档案 (昵称等展示信息) */
	profile: UserProfileManager | null = null;
	/** 消息过滤名单 (全局 + 各 Bot 私有) */
	filterList: FilterListManager | null = null;


	session: SessionManager | null = null;

	webui: WebUIServer | null = null;
	statistics: StatisticsManager | null = null;

	constructor(config?: CoreOption) {
		this.config = Object.assign(this.config, config)
	}

	async init() {

		// 验证目录
		await dirCheck(path.join(root, "data"));

		let dbPath = path.join(root, "data", "internal.db");


		this.internalDB = new sqlite(dbPath);
		this.internalDB.pragma('journal_mode = WAL'); // 设为WAL, 因为需要抗高并发
		this.internalDB.pragma('synchronous = NORMAL');

		this.user = new UserManager(this.internalDB);
		this.session = new SessionManager(this.internalDB);
		this.profile = new UserProfileManager(this.internalDB);
		this.filterList = new FilterListManager(this.internalDB);

		this.user.init()
		this.session.init()
		this.profile.init()
		this.filterList.init()

		if (this.config.webui) {
			await import("./webui/server/server").then(module => {
				const server = module.WebUIServer;
				const webui = new server({
					core: this,
					...this.config.webuiOption
				})
				this.webui = webui;
			}).catch(e => {
				logger.error(`初始化WebUI失败: ${e.message}`, e)
			})
		}
		await this.webui?.start();

		if (this.config.statistics !== false) {
			await import("./statistics/manager").then(module => {
				this.statistics = new module.StatisticsManager(
					path.join(root, "data", "statistics.db"),
					this.config.statisticsOption,
				);
			}).catch(e => {
				// 统计是可选模块, 整个目录被删除时不应影响启动
				if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") {
					logger.warn("统计模块不存在, 已跳过统计功能");
				} else {
					logger.error(`初始化统计失败: ${e.message}`, e);
				}
			});
		}


		// 服务插件先于 Bot 加载: Bot 的插件可能通过 ctx.require 依赖服务的导出
		await this.services.scan();
		await this.services.syncState();

		await this.bot.scan(path.join(root, "bots")) // 扫描bot目录
		await this.bot.syncState();

	}

	async close() {
		if (this._disposed) return;
		this._disposed = true;
		this.internalDB?.close(); // 关闭数据库连接
		await this.bot.dispose(); // 停止所有Bot, 并释放状态文件监听
		await this.services.dispose(); // 卸载服务插件(基础设施最后倒, 与启动顺序相反)
		await this.webui?.close() // 停止webui
		this.statistics?.close(); // 冲刷统计缓冲并关闭数据库
		this.session = null;
		this.user = null;
		this.profile = null;
		this.filterList = null;
	}

	/**
	 * 核心是否已销毁
	 */
	get disposed() {
		return this._disposed;
	}
}