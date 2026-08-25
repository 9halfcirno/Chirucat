import { readFileSync, readSync } from "fs";
import { Bot } from "./src/bot/bot";
import { AdapterContext } from "./src/plugin/contexts/adapter-context";
import { PluginLoader } from "./src/plugin/loader";
import { Plugin } from "./src/plugin/plugin";
import { UserManager } from "./src/user-manager";
import path from "path";
import { SessionManager } from "./src/session-manager";
import { log } from "console";
import { Core } from "./src/core";

const core = new Core();
await core.start();

await core.bot.start("chirucat");

const bot = core.bot.bots.get("chirucat")!;

bot.plugin.load("qq-adapter")
bot.plugin.load("ping")

bot.command.register({
	name: "test",
	handler(message, args) {
		console.log(args);
		
	},
})