import type { WebUIAPI } from "../types";
import { fail, requireBot } from "./_shared";

const api: WebUIAPI = {
	path: "get_bot_state",
	method: "POST",
	auth: true,

	handler(req, core) {
		// 独立启动的 WebUI 没有核心: 返回空对象, 前端据此隐藏依赖核心的部分
		if (!core) return {};

		const id = req.body?.id;
		if (!id) {
			fail(404, "未传入bot id");
		}

		const bot = requireBot(core, id);

		return {
			id: bot.id,
			name: bot.name,
			// 运行态与期望态分开返回: 判断"是否正在运行"必须用 running,
			// state.enable 只是持久化的期望(可能尚未收敛, 也可能收敛失败)
			running: bot.running,
			state: bot.state.get()
		};
	}
}

export default api;
