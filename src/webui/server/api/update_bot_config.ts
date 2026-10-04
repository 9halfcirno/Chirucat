import type { WebUIAPI } from "../types";
import { requireBot, requireCore, rethrowSettingsError } from "./_shared";

/**
 * 更新某个 Bot 的设置
 *
 * POST
 * 请求体
 * - id: 目标 Bot id
 * - patch: 改动 (前端 config-editor 的 getValues() 输出; 未提交的字段保留原值)
 *
 * 值文件就是 `<Bot目录>/config.json`。
 *
 * `id` 在定义里标了 immutable: 提交一个不同的 id 会被拒绝 —— 它同时是目录名、
 * `BotManager.bots` 的 Map 键与插件配置路径的基准, 改名必须是一次专门的迁移,
 * 不能藏在"保存设置"里。
 */
const api: WebUIAPI = {
	path: "update_bot_config",
	method: "POST",
	auth: true,

	async handler(req, core) {
		const bot = requireBot(requireCore(core), `${req.body?.id ?? ""}`);

		try {
			const result = await bot.settings.patch(req.body?.patch);
			return { success: true, ...result };
		} catch (e) {
			rethrowSettingsError(e, "保存Bot设置");
		}
	},
};

export default api;
