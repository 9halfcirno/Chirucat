import type { WebUIAPI } from "../types";
import { isValidBotId } from "../../../helpers/bot-helper";

/**
 * 创建Bot
 * POST
 * 请求体
 * - id: Bot唯一标识, 同时作为 bots/ 下的目录名 (必填, 规则见 isValidBotId)
 * - name: Bot显示名 (可选, 留空则只显示 id)
 * 返回
 * - { success: true, id, path } 创建成功后 Bot 目录的绝对路径
 */

const api: WebUIAPI = {
	path: "create_bot",
	method: "POST",
	auth: true,

	async handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const body = (req.body ?? {}) as { id?: unknown; name?: unknown };
		const { id, name } = body;

		// id 规则与 BotHelper 共用同一校验, 服务端为准
		if (!isValidBotId(id)) {
			throw {
				code: 400,
				err: "id不合法: 需为1~64位字符, 且不能含空白、点目录或 < > : \" / \\ | ? * 等字符",
			};
		}
		if (core.bot.bots.has(id)) {
			throw { code: 409, err: `Bot ${id} 已存在` };
		}

		// name 可选; 空串/纯空白按未填写处理
		const trimmedName = typeof name === "string" ? name.trim() : "";
		const botConfig = trimmedName ? { id, name: trimmedName } : { id };

		try {
			const dir = await core.botHelper.add(botConfig);
			return { success: true, id, path: dir };
		} catch (e) {
			// 创建中途失败(如磁盘写入出错), BotHelper 已尽量不产生半成品残留
			throw { code: 500, err: `创建Bot失败: ${(e as Error).message}` };
		}
	},
};

export default api;
