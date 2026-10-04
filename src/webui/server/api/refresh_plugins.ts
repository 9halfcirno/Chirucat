import type { WebUIAPI } from "../types";
import { fail, requireBot, requireCore } from "./_shared";
import { buildPluginPayload } from "../plugin-view";

/**
 * 重新扫描插件目录并返回最新的插件列表
 *
 * POST
 * 请求体
 * - bot: 目标bot id
 *
 * 与 scan_bots 同语义: 先扫描磁盘, 再回传结果 —— 刷新与首次加载都走这里,
 * 前端拿到的一定是和目录对齐的列表。
 *
 * 只更新注册表, 不加载/卸载插件, 因此未运行的 Bot 也能调用: 此时列表能正常
 * 展示, 但插件状态都是未加载(registered), 前端据此禁用启停开关。
 */
export default {
	method: "POST",
	path: "refresh_plugins",
	auth: true,

	async handler(req, core) {
		const bot = requireBot(requireCore(core), `${req.body?.bot ?? ""}`);

		try {
			await bot.refreshPlugins();
		} catch (e) {
			fail(500, `刷新插件失败: ${(e as Error).message}`);
		}

		return {
			success: true,
			// 与启停接口一样带上运行态: 前端要用它决定开关是否可用
			...buildPluginPayload(bot),
		};
	},
} as WebUIAPI;
