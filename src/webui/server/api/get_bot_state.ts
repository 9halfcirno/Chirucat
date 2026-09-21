import type { WebUIAPI } from "../types";

const api: WebUIAPI = {
	path: "get_bot_state",
	method: "POST",
	auth: true,

	handler(req, core) {
		if (!core) return {};

		const id = req.body?.id;
		if (!id) {
			throw { code: 404, err: "未传入bot id" };
		}

		const bot = core.bot.bots.get(id);
		if (!bot) {
			throw { code: 404, err: "目标Bot不存在" };;
		}

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