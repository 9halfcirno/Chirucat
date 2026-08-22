import { Bot } from "./src/bot/bot";
import { Message } from "./src/entity/message";

const bot = new Bot()

await bot.start()

bot.dispatch(new Message("aafucka"))