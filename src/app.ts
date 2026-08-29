import { Core } from "./core";
import Logger from "./utils/logger";

const logger = new Logger("App");

process.on("unhandledRejection", (reason) => {
	logger.error("未捕获的 Promise 异常: ", reason);
});

process.on("uncaughtException", (e) => {
	logger.error("未捕获的异常: ", e.message);
});

appStart();

async function appStart() {
	logger.log(`正在启动 Chirucat 核心`)

	let core: Core;

	try {
		core = new Core({
			webui: true
		})
		await core.init();
		logger.log(`Chirucat 核心启动成功`)
	} catch (e) {
		logger.error(`Chirucat 核心启动失败`, e)
	}
	process.once("SIGINT", exit);
	process.once("SIGTERM", exit);

	async function exit() {
		logger.log(`Chirucat 正在退出`)
		if (core) {
			logger.log(`正在关闭 Chirucat 核心`)
			try {
				await core.close();
				logger.log(`Chirucat 核心已关闭`)
			} catch (e) {
				logger.error(`尝试关闭 Chirucat 核心时出现错误: `, e)
			}
		}
		logger.log(`Chirucat 已退出`)

		process.exit(0);
	}
}