import { startCore, stopCore } from "../../../app";
import Logger from "../../../utils/logger";
import type { WebUIAPI } from "../types";

const logger = new Logger(`WebUI Core重启接口`);

const api: WebUIAPI = {
	path: "reboot_core",
	method: "GET",
	auth: true,

	async handler(_, core) {
		if (!core) throw { code: 409, err: "当前WebUI脱离Core运行!" };

		logger.log(`尝试重启Chirucat Core!`)
		try {
			await stopCore() // 关闭
				.then(() => setTimeout(() => startCore(), 3000)); // 尝试3s后重启, 避免造成cpu过大压力

			 
		} catch (e) {
			logger.error(`Core启动失败!`, e);
		}


		return "I love Cirno!!"; // 返回什么已经无所谓了, 毕竟stopCore会关掉这个连接
	}
}

export default api;