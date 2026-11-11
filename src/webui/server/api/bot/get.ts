import type { WebUIAPI } from "../../types";
import { fail, requireBot, requireCore } from "../_shared";

/**
 * 获取 Bot 对象信息, 包括状态/信息等
 *
 * 请求体
 * - bot: 目标 Bot id
 *
 * 返回:
 * - id: Bot 的唯一标识
 * - name: Bot 的名称
 * - running: Bot 运行状态
 * - runningTime: Bot 启动后的运行时长
 * - state: Bot 状态数据, 包括期望状态和启用的插件
 */
const api: WebUIAPI = {
	method: "POST",
	auth: true,

	handler(req, core) {
		let c = requireCore(core);

		const id = req.body?.bot;
		if (!id) {
			fail(400, "未传入bot id");
		}

		const bot = requireBot(c, id);

		return {
			id: bot.id,
			name: bot.name,
			// 运行态与期望态分开返回: 判断"是否正在运行"必须用 running,
			// state.enable 只是持久化的期望(可能尚未收敛, 也可能收敛失败)
			running: bot.running,
			runningTime: bot.running ? Date.now() - bot.runningAt : null,
			state: bot.state.get()
		};
	}
}

export default api;
