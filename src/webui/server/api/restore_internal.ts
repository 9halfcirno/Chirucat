import type { WebUIAPI } from "../types";

/**
 * 恢复到上一个跨平台ID: 把账号重新并回它变更前所在的组
 * POST
 * 请求体
 * - platform: 平台名
 * - id: 平台用户ID
 * 返回
 * - accountId: 账号ID
 * - unionId: 恢复后的跨平台ID
 * - lastUnionId: 本次被放弃的那个跨平台ID
 *
 * 目标组若已无其他成员, 恢复后该账号将独占该组 (组由成员定义, 不存在显式建组)。
 */

const api: WebUIAPI = {
	path: "restore_internal",
	method: "POST",
	auth: true,

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };
		if (!core.user) throw { err: "核心用户模块未就绪", code: 503 };

		const { platform, id } = parseTarget(req.body);

		const accountId = core.user.find(platform, id);
		if (!accountId) throw { code: 404, err: `账号不存在: ${platform} ${id}` };

		if (!core.user.getLast(accountId)) {
			throw { code: 400, err: "该账号没有可恢复的上一个跨平台ID" };
		}

		const unionId = core.user.restore(accountId);
		if (!unionId) throw { code: 409, err: "恢复失败: 该账号当前已在该跨平台ID下" };

		return {
			accountId,
			unionId,
			lastUnionId: core.user.getLast(accountId),
		};
	},
};

/** 校验并取出 platform / id, 两者都必须是非空字符串 */
function parseTarget(body: unknown): { platform: string; id: string } {
	const { platform, id } = (body ?? {}) as { platform?: unknown; id?: unknown };
	if (typeof platform !== "string" || !platform.trim()) {
		throw { code: 400, err: "platform 必须是非空字符串" };
	}
	if (typeof id !== "string" || !id.trim()) {
		throw { code: 400, err: "id 必须是非空字符串" };
	}
	return { platform: platform.trim(), id: id.trim() };
}

export default api;
