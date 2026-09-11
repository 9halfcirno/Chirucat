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

const logger = new Logger("Core")

export class Core {
	config: CoreOption = {
		webui: true,
	};
	bot = new BotManager(this)
	botHelper = new BotHelper(this)
	user: UserManager | null = null;
	session: SessionManager | null = null;

	webui: WebUIServer | null = null;
	statistics: StatisticsManager | null = null;

	constructor(config?: CoreOption) {
		this.config = Object.assign(this.config, config)
	}

	async init() {

		// 验证目录
		await dirCheck(path.join(root, "data"));

		this.user = new UserManager(path.join(root, "data", "internal.db"));
		this.session = new SessionManager(path.join(root, "data", "internal.db"));

		this.user.init()
		this.session.init()

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

		
		await this.bot.scan(path.join(root, "bots")) // 扫描bot目录
		await this.bot.syncState();

	}

	async close() {
		await this.bot.stop(); // 关闭bot
		await this.webui?.close() // 停止webui
		this.statistics?.close(); // 冲刷统计缓冲并关闭数据库
	}
}