import type { WebUIAPI } from "../types";

/**
 * 解绑: 将账号从当前跨平台ID中移出, 独立成新的跨平台ID
 * POST
 * 请求体
 * - platform: 平台名
 * - id: 平台用户ID
 * 返回
 * - accountId: 账号ID
 * - unionId: 解绑后所属的新跨平台ID
 * - lastUnionId: 解绑前的跨平台ID (已记入历史, 可被 restore_internal 恢复)
 */

const api: WebUIAPI = {
	path: "unbind_account",
	method: "POST",
	auth: true,

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };
		if (!core.user) throw { err: "核心用户模块未就绪", code: 503 };

		const { platform, id } = parseTarget(req.body);

		const accountId = core.user.find(platform, id);
		if (!accountId) throw { code: 404, err: `账号不存在: ${platform} ${id}` };

		const unionId = core.user.getUnion(accountId);
		if (!unionId) throw { code: 404, err: "该账号未归属任何跨平台ID" };

		if (!core.user.unbind(unionId, accountId)) {
			throw { code: 409, err: "解绑失败: 该账号不在指定的跨平台ID下" };
		}

		const newUnionId = core.user.getUnion(accountId);
		if (!newUnionId) throw { code: 500, err: "解绑后读取跨平台ID失败" };

		return {
			accountId,
			unionId: newUnionId,
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
