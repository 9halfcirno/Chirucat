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
import { HookBus } from "./hooks/bus";
import { StateError } from "./errors/state-error";
import {
	WEBUI_DOMAIN_ID,
	WEBUI_SETTINGS_FILE,
	webuiSettings,
	initialWebUISettings,
	type WebUISettings,
} from "./config/settings/domains/webui";
import {
	CORE_DOMAIN_ID,
	CORE_SETTINGS_FILE,
	coreSettings,
	initialCoreSettings,
	type CoreSettings,
} from "./config/settings/domains/core";
import {
	STATISTICS_DOMAIN_ID,
	STATISTICS_SETTINGS_FILE,
	statisticsSettings,
	initialStatisticsSettings,
	type StatisticsSettings,
} from "./config/settings/domains/statistics";
import {
	LOGGING_DOMAIN_ID,
	LOGGING_SETTINGS_FILE,
	loggingSettings,
	type LoggingSettings,
} from "./config/settings/domains/logging";
import { CronManager } from "./utils/cron-manager";

const logger = new Logger("Core")

export class Core {
	private _disposed: boolean = false;
	/**
	 * 启动期显式覆盖, 仅用于测试与嵌入式注入
	 *
	 * 正常启动不给任何覆盖: 值一律来自 `configs/*.json` 的设置域(见 initSettings)。
	 * 这里给了的字段优先级最高, 检查脚本靠它关掉 WebUI / 统计, 避免占端口或联网。
	 */
	config: CoreOption = {};
	bot = new BotManager(this);
	botHelper = new BotHelper(this);
	/** 服务插件宿主: services/ 下的框架级插件, 全局单例, 生命周期由 Core 管理 */
	services = new ServiceHost(this);
	/** 设置域注册表: 框架各模块的可变配置挂在这里, 由 WebUI 设置页统一读写 */
	settings = new SettingsManager();

	/** Cron调度: 框架Cron调度器, 管理Cron对象 */
	cron: CronManager | null = null;

	/** Hook 总线: 框架埋点, 服务插件通过 ctx.hook 注册 handler 干涉流程 */
	readonly hooks = new HookBus();

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
		// Hook 埋点: 核心初始化之前
		if (this.hooks.dispatch("before.core.init", this)) {
			throw new StateError("Core 初始化被 Hook 取消");
		}

		// 验证目录
		await dirCheck(path.join(root, "data"));

		// 创建Cron调度器
		this.cron = new CronManager();
		// 任务异常必须有出口: 插件里的 handler 抛错不应无声消失
		this.cron.onError((error, job) => {
			logger.error(`Cron任务 "${job.name ?? "<unnamed>"}" 执行出错:`, error);
		});

		// 设置域先就绪: 后面创建的模块都从它取值
		await this.initSettings();

		let dbPath = path.join(root, "data", "internal.db");


		this.internalDB = new sqlite(dbPath);
		this.internalDB.pragma('journal_mode = WAL'); // 设为WAL, 因为需要抗高并发
		this.internalDB.pragma('synchronous = NORMAL');
		this.internalDB.pragma('foreign_keys = ON'); // 启用外键约束

		this.user = new UserManager(this.internalDB);
		this.session = new SessionManager(this.internalDB);
		this.profile = new UserProfileManager(this.internalDB);

		// 顺序要求: 这些设施必须先于服务插件就绪 —— 服务插件的 ctx.core.user / session 等
		// 直接依赖它们(见下面对 services 的加载), 这里往前挪一步就会让依赖设施的插件起不来。

		this.user.init()
		this.session.init()
		this.profile.init()

		// 启动参数统一从设置域取: 它与运行期读写、WebUI 设置页共用同一份值文件
		const startup = this.resolveStartupSettings();

		if (startup.webui) {
			await import("./webui/server/server").then(module => {
				const server = module.WebUIServer;
				const webui = new server({
					core: this,
					...(startup.webuiOption ?? {})
				})
				this.webui = webui;
			}).catch(e => {
				logger.error(`初始化WebUI失败: ${e.message}`, e)
			})
		}
		await this.webui?.start();

		if (startup.statistics) {
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
	 * 解析启动期配置: 显式注入 > 设置域 > 定义默认值
	 *
	 * 只在 `init()` 里、设置域载入完成之后调用。单独成方法是为了让检查脚本能在
	 * 不启动 WebUI / 数据库的情况下验证"启动参数确实来自设置域"。
	 */
	resolveStartupSettings(): {
		webui: boolean;
		statistics: boolean;
		webuiOption: WebUISettings | undefined;
	} {
		const coreValues = this.settings.domain<CoreSettings>(CORE_DOMAIN_ID)?.get();
		return {
			webui: this.config.webui ?? coreValues?.webui ?? true,
			statistics: this.config.statistics ?? coreValues?.statistics ?? true,
			webuiOption: this.settings.domain<WebUISettings>(WEBUI_DOMAIN_ID)?.get(),
		};
	}

	/**
	 * 装配框架自身的设置域并载入 —— 启动参数与运行期配置的唯一入口
	 *
	 * 值文件只有一处真相源: 启动参数从这里读(见 resolveStartupSettings), 运行期的
	 * 读写、校验与热应用也走这里, app.ts 不再自己读一遍配置文件。
	 * "首次生成什么"由各域导出的 initial* 工厂(见 onCreate)决定 —— 尤其保证
	 * webui.json 永远不会以"空密码"的形态被创建出来。
	 *
	 * 载入结果里的 created / recovered 在这里统一转成日志: 域定义文件只描述数据,
	 * 不掺日志逻辑。单独成方法也是为了能被检查脚本直接调用。
	 */
	async initSettings(): Promise<void> {
		// Core 自身的开关
		this.settings.register<CoreSettings>(CORE_DOMAIN_ID, {
			definition: coreSettings,
			file: CORE_SETTINGS_FILE,
			onCreate: initialCoreSettings,
			apply: (values, changed) => this.applyCoreSettings(values, changed),
			onLoad: (values) => this.applyCoreSettings(values, []),
		});

		// webui 域始终注册, 不随启动开关走: 模块被关掉时, 更需要能从设置页把它打开
		this.settings.register<WebUISettings>(WEBUI_DOMAIN_ID, {
			definition: webuiSettings,
			file: WEBUI_SETTINGS_FILE,
			// 定义里 password 的默认值是空串(运行期语义 = 不鉴权),
			// 直接由它生成文件会得到裸奔的管理后台 —— 首次内容必须走随机密码
			onCreate: initialWebUISettings,
			apply: (values, changed) => this.applyWebUISettings(values, changed),
			// 载入时什么都无需热应用: 服务器就是用这份配置构造出来的
			onLoad: (values) => this.applyWebUISettings(values, []),
		});

		// 统计域不随模块启停而注册: 模块被关掉时, 更需要能从设置页把它打开
		this.settings.register<StatisticsSettings>(STATISTICS_DOMAIN_ID, {
			definition: statisticsSettings,
			file: STATISTICS_SETTINGS_FILE,
			onCreate: initialStatisticsSettings,
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

		// 损坏的值文件在载入时备份并重建, 真正失败(如备份写不了)仍不阻断其它域
		const { loaded, failures } = await this.settings.loadAll();

		for (const { id, result } of loaded) {
			if (result.recovered) {
				logger.warn(`设置域 ${id} 的值文件已损坏并重建, 原文件备份在: ${result.backupFile ?? "(未知)"}`);
			}
		}
		if (failures.length > 0) {
			logger.warn(`${failures.length} 个设置域载入失败, 已使用定义默认值继续启动`);
		}

		// 首次生成 WebUI 配置时把随机密码打到终端。以前靠 app.ts 读文件的 created
		// 标志, 现在改由域载入结果提供 —— 域定义文件里一行日志都不用加
		const webui = loaded.find(({ id }) => id === WEBUI_DOMAIN_ID)?.result;
		if (webui?.created) {
			logger.log("=======================");
			logger.log(`已生成初始密码: ${(webui.values as WebUISettings).password}`);
			logger.log("=======================");
		}
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
	 * 参数以设置域为准 —— 它既是运行期、也是启动期的真相源。
	 */
	private async createStatistics(): Promise<void> {
		const options = this.settings.domain<StatisticsSettings>(STATISTICS_DOMAIN_ID)?.get();

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

		// 与启动顺序相反地释放。某一步抛错不能让后面的步骤跟着被跳过
		// (services 没卸载会留下运行中的定时器, webui 没关会占着端口),
		// 也不能让外部拿到"半释放"的实例, 因此释放与清空分置 try/finally 两侧
		try {
			this.internalDB?.close(); // 关闭数据库连接
			await this.bot.dispose(); // 停止所有Bot, 并释放状态文件监听
			await this.services.dispose(); // 卸载服务插件(基础设施最后倒, 与启动顺序相反)

			logger.log(`正在停止所有Cron任务, 并等待运行中任务完成`)
			this.cron?.stopAll(); // 停止所有调度
			await this.cron?.waitIdle(15_000); // 等待15s内所有任务完成

			await this.webui?.close() // 停止webui
			this.settings.close(); // 释放设置域(含值文件监听)
			this.statistics?.close(); // 冲刷统计缓冲并关闭数据库
		} catch (e) {
			logger.error("关闭 Core 时出错:", e);
		} finally {
			this.cron = null;  // 不再暴露Cron
			this.webui = null; // 释放后不再把已停止的服务器给出去
			this.statistics = null; // 置空后 ctx.core.statistics 才如实返回 null, 而不是已关闭的实例
			this.session = null;
			this.user = null;
			this.profile = null;
		}
	}

	/**
	 * 核心是否已销毁
	 */
	get disposed() {
		return this._disposed;
	}
}