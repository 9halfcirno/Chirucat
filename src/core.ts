import path from "path";
import { BotManager } from "./bot/manager";
import { BotHelper } from "./helpers/bot-helper";
import { UserManager } from "./internal/user-manager";
import { root } from "./utils/root";
import { SessionManager } from "./internal/session-manager";
import type { CoreOption } from "./types";
import Logger, { setLogLevel } from "./utils/logger";
import { dirCheck } from "./utils/dir-check";
import type { StatisticsManager } from "./statistics/manager";
import type { WebUIServer } from "./webui/server/server";
import sqlite from "better-sqlite3";
import { UserProfileManager } from "./internal/user-profile";
import { ServiceHost } from "./plugin/services/host";
import { SettingsManager } from "./config/settings/manager";
import {
	WEBUI_DOMAIN_ID,
	WEBUI_SETTINGS_FILE,
	webuiSettings,
	type WebUISettings,
} from "./config/settings/domains/webui";
import {
	CORE_DOMAIN_ID,
	CORE_SETTINGS_FILE,
	coreSettings,
	type CoreSettings,
} from "./config/settings/domains/core";
import {
	STATISTICS_DOMAIN_ID,
	STATISTICS_SETTINGS_FILE,
	statisticsSettings,
	type StatisticsSettings,
} from "./config/settings/domains/statistics";
import {
	LOGGING_DOMAIN_ID,
	LOGGING_SETTINGS_FILE,
	loggingSettings,
	type LoggingSettings,
} from "./config/settings/domains/logging";

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
	/** 设置域注册表: 框架各模块的可变配置挂在这里, 由 WebUI 设置页统一读写 */
	settings = new SettingsManager();

	private internalDB: sqlite.Database | null = null;
	user: UserManager | null = null;
	/** 用户档案 (昵称等展示信息) */
	profile: UserProfileManager | null = null;
	/**
	 * 消息过滤名单 (黑白名单) 已抽离为服务插件 `services/filter`:
	 * 存储、判定与 WebUI 端点都在那里, 框架不再持有名单入口。
	 */


	session: SessionManager | null = null;

	webui: WebUIServer | null = null;
	statistics: StatisticsManager | null = null;

	constructor(config?: CoreOption) {
		this.config = Object.assign(this.config, config)

		// 嵌入式/测试场景可把服务插件状态文件指到别处(默认 configs/services/state.json)
		if (config?.servicesStateFile) this.services.setStateFile(config.servicesStateFile);
	}

	async init() {

		// 验证目录
		await dirCheck(path.join(root, "data"));

		// 设置域先就绪: 后面创建的模块都从它取值
		await this.initSettings();

		let dbPath = path.join(root, "data", "internal.db");


		this.internalDB = new sqlite(dbPath);
		this.internalDB.pragma('journal_mode = WAL'); // 设为WAL, 因为需要抗高并发
		this.internalDB.pragma('synchronous = NORMAL');

		this.user = new UserManager(this.internalDB);
		this.session = new SessionManager(this.internalDB);
		this.profile = new UserProfileManager(this.internalDB);

		// 顺序要求: 这些设施必须先于服务插件就绪 —— 服务插件的 ctx.core.user / session 等
		// 直接依赖它们(见下面对 services 的加载), 这里往前挪一步就会让依赖设施的插件起不来。

		this.user.init()
		this.session.init()
		this.profile.init()

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
			await this.createStatistics();
		}


		// 服务插件先于 Bot 加载: Bot 的插件可能通过 ctx.require 依赖服务的导出。
		// 先装载持久化期望态, 再扫描, 最后按期望收敛 —— 被停用过的服务不会被拉起。
		await this.services.initState();
		await this.services.scan();
		await this.services.syncState();

		await this.bot.scan(path.join(root, "bots")) // 扫描bot目录
		await this.bot.syncState();

	}

	/**
	 * 装配框架自身的设置域并载入
	 *
	 * 值文件与 app.ts 启动时读的是同一份: 域负责**运行期**的读写、校验与变更通知,
	 * 启动参数仍由 app.ts 组装 —— 它会先给缺失的 webui.json 生成随机密码,
	 * 域随后读回那份密码, 所以不会退化成"无密码开放"。
	 *
	 * 单独成方法是为了能在不起 Bot 的情况下被检查脚本直接调用。
	 */
	async initSettings(): Promise<void> {
		// Core 自身的开关
		this.settings.register<CoreSettings>(CORE_DOMAIN_ID, {
			definition: coreSettings,
			file: CORE_SETTINGS_FILE,
			apply: (values, changed) => this.applyCoreSettings(values, changed),
			onLoad: (values) => this.applyCoreSettings(values, []),
		});

		if (this.config.webui) {
			this.settings.register<WebUISettings>(WEBUI_DOMAIN_ID, {
				definition: webuiSettings,
				file: WEBUI_SETTINGS_FILE,
				apply: (values, changed) => this.applyWebUISettings(values, changed),
				// 载入时什么都无需热应用: 服务器就是用这份配置构造出来的
				onLoad: (values) => this.applyWebUISettings(values, []),
			});
		}

		// 统计域不随模块启停而注册: 模块被关掉时, 更需要能从设置页把它打开
		this.settings.register<StatisticsSettings>(STATISTICS_DOMAIN_ID, {
			definition: statisticsSettings,
			file: STATISTICS_SETTINGS_FILE,
			apply: (values) => { this.statistics?.updateOptions(values); },
			onLoad: (values) => { this.statistics?.updateOptions(values); },
		});

		// 日志级别是热生效的: 直接改 Logger 的全局最低级别, 无需重启
		this.settings.register<LoggingSettings>(LOGGING_DOMAIN_ID, {
			definition: loggingSettings,
			file: LOGGING_SETTINGS_FILE,
			apply: (values) => { setLogLevel(values.level); },
			onLoad: (values) => { setLogLevel(values.level); },
		});

		// 单个域的文件损坏不阻断启动: loadAll 内部已逐域记录日志
		await this.settings.loadAll();
	}

	/**
	 * 把 webui 域的改动热应用到运行中的服务器
	 *
	 * 顺序有讲究: 先改内存里的校验开关(密码/本机免密), 最后才换监听 —— 换监听
	 * 会提前断掉当前连接(包括正在回这个请求的那一条), 所以推到响应写出之后再执行。
	 */
	private async applyWebUISettings(values: WebUISettings, changed: string[]): Promise<void> {
		const webui = this.webui;
		if (!webui) return;

		if (changed.includes("password") || changed.includes("localNoAuth")) {
			webui.updateSecurity({
				...(changed.includes("password") ? { password: values.password } : {}),
				...(changed.includes("localNoAuth") ? { localNoAuth: values.localNoAuth === true } : {}),
			});
		}

		// 下发给前端的内存开关
		if (values.frontConfig) webui.front = { ...values.frontConfig };

		if (changed.includes("port") || changed.includes("host")) {
			const port = Number(values.port);
			const host = String(values.host);
			// 当前请求就靠这条连接回包: 立刻重开会把它一起掰掉, 调用方收不到任何响应
			setTimeout(() => {
				void webui.relisten(port, host).catch((e) => {
					const reason = e instanceof Error ? e.message : String(e);
					logger.error(`WebUI 更换监听失败 (${host}:${port}): ${reason}`);
				});
			}, 100);
		}
	}

	/**
	 * 把 core 域的改动热应用
	 *
	 * 目前只有 `statistics` 需要在运行期响应(开着就建、关了就关); `webui` 是
	 * immutable, 不会走到这里。
	 */
	private async applyCoreSettings(values: CoreSettings, changed: string[]): Promise<void> {
		if (changed.includes("statistics")) {
			await this.applyStatisticsEnabled(values.statistics === true);
		}
	}

	/**
	 * 开关统计模块
	 *
	 * 关掉不删统计库 —— 数据留着, 重新打开就还在。
	 */
	private async applyStatisticsEnabled(enabled: boolean): Promise<void> {
		if (enabled && !this.statistics) {
			await this.createStatistics();
			return;
		}
		if (!enabled && this.statistics) {
			this.statistics.close();
			this.statistics = null;
			logger.log("统计模块已关闭");
		}
	}

	/**
	 * 创建统计模块
	 *
	 * 统计是可选模块(整个目录可被删除), 因此走动态 import, 失败只记日志;
	 * 参数以设置域为准 —— 它才是运行期的真相源。
	 */
	private async createStatistics(): Promise<void> {
		const options = this.settings.domain<StatisticsSettings>(STATISTICS_DOMAIN_ID)?.get()
			?? this.config.statisticsOption;

		try {
			const module = await import("./statistics/manager");
			this.statistics = new module.StatisticsManager(
				path.join(root, "data", "statistics.db"),
				options,
			);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
				logger.warn("统计模块不存在, 已跳过统计功能");
				return;
			}
			logger.error(`初始化统计失败: ${e instanceof Error ? e.message : e}`, e);
		}
	}

	async close() {
		if (this._disposed) return;
		this._disposed = true;
		this.internalDB?.close(); // 关闭数据库连接
		await this.bot.dispose(); // 停止所有Bot, 并释放状态文件监听
		await this.services.dispose(); // 卸载服务插件(基础设施最后倒, 与启动顺序相反)
		await this.webui?.close() // 停止webui
		this.webui = null; // 释放后不再把已停止的服务器给出去
		this.settings.close(); // 释放设置域(含值文件监听)
		this.statistics?.close(); // 冲刷统计缓冲并关闭数据库
		this.statistics = null; // 置空后 ctx.core.statistics 才如实返回 null, 而不是已关闭的实例
		this.session = null;
		this.user = null;
		this.profile = null;
	}

	/**
	 * 核心是否已销毁
	 */
	get disposed() {
		return this._disposed;
	}
}