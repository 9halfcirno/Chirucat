import path from "path";
import { BotManager } from "./bot/manager";
import { UserManager } from "./user-manager";
import { root } from "./utils/root";
import { SessionManager } from "./session-manager";

export class Core {
	bot = new BotManager(this)
	user = new UserManager(path.join(root, "data", "internal.db"));
	session = new SessionManager(path.join(root, "data", "internal.db"));

	constructor() {
		this.user.init()
		this.session.init()
	}


	async start() {
		await this.bot.scan(path.join(root, "bots"));
	}
}