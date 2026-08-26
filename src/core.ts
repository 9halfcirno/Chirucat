import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import { BotManager } from "./bot/manager";
import { UserManager } from "./user-manager";
import { root } from "./utils/root";
import { SessionManager } from "./session-manager";

export class Core {
	bot = new BotManager(this)
	user = new UserManager(path.join(root, "data", "internal.db"));
	session = new SessionManager(path.join(root, "data", "internal.db"));

	constructor() {

	}

	async init() {
		this.user.init()
		this.session.init()
		
		await this.bot.scan(path.join(root, "bots")) // 扫描bot目录


	}
}