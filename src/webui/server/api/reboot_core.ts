import { startCore, stopCore } from "../../../app";
import Logger from "../../../utils/logger";
import type { WebUIAPI } from "../types";
import { fail, requireCore } from "./_shared";

const logger = new Logger(`WebUI Core重启接口`);

/** 关闭后隔多久再重启: stopCore 会掐断正在回这个请求的连接, 立刻重启会与未完成的关闭竞争 */
const RESTART_DELAY_MS = 3_000;

const api: WebUIAPI = {
	path: "reboot_core",
	method: "GET",
	auth: true,

	async handler(_, core) {
		requireCore(core);

		logger.log(`尝试重启Chirucat Core!`)
		try {
			await stopCore(); // 关闭: 会断掉当前连接
		} catch (e) {
			logger.error(`关闭 Core 失败!`, e);
			fail(500, `关闭 Core 失败: ${e instanceof Error ? e.message : String(e)}`);
		}

		// 停掉之后再异步重启。重启的失败必须接住: 它发生在本次请求之后,
		// 冒成 unhandledRejection 会拖崩进程(而且那时 Core 已经关了, 没有兜底)
		setTimeout(() => {
			void startCore().catch((e) => {
				logger.error(`Core 重启失败!`, e);
			});
		}, RESTART_DELAY_MS);

		return "I love Cirno!!"; // stopCore 会关掉这个连接, 返回什么前端都收不到
	}
}

export default api;
