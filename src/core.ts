import path from "path";
import { BotManager } from "./bot/manager";
import { UserManager } from "./user-manager";
import { root } from "./utils/root";
import { SessionManager } from "./session-manager";
import type { CoreOption } from "./types";
import Logger from "./utils/logger";
import { dirCheck } from "./utils/dir-check";
import type { WebUIServer } from "./webui/server/server";

const logger = new Logger("Core")

export class Core {
	
	bot = new BotManager(this)
	user: UserManager | null = null;
	session: SessionManager | null = null;

	webui: WebUIServer | null = null;

	constructor(config?: CoreOption) {
		config = Object.assign({
			webui: true
		}, config)

		if (config.webui) {
			import("./webui/server/server").then(module => {
				const server = module.WebUIServer;
				const webui = new server({ core: this })
				this.webui = webui;
			}).catch(e => {
				logger.error(`初始化WebUI失败: ${e.message}`, e)
			})
		}
	}

	async init() {

		// 验证目录
		await dirCheck(path.join(root, "data"));

		this.user = new UserManager(path.join(root, "data", "internal.db"));
		this.session = new SessionManager(path.join(root, "data", "internal.db"));

		this.user.init()
		this.session.init()

		await this.webui?.start();

		
		await this.bot.scan(path.join(root, "bots")) // 扫描bot目录


	}
}