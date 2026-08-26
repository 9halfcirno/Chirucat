import { Core } from "./src/core";

const core = new Core();
await core.init();

await core.bot.start("chirucat");

const bot = core.bot.bots.get("chirucat")!;
