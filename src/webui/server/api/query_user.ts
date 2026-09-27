import type { WebUIAPI } from "../types";

/**
 * 查询用户: 平台 + 平台用户ID -> 账号ID / 跨平台ID / 组内成员
 * POST
 * 请求体
 * - platform: 平台名
 * - id: 平台用户ID
 * 返回
 * - platform / id: 查询目标回显
 * - accountId: 账号ID
 * - unionId: 跨平台ID
 * - lastUnionId: 上一个跨平台ID, 无记录为 null
 * - members: 同一跨平台ID下的全部账号
 *
 * 纯查询接口: 账号不存在时返回 404, 不会为其建档
 */

const api: WebUIAPI = {
	path: "query_user",
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

		return {
			platform,
			id,
			accountId,
			unionId,
			lastUnionId: core.user.getLast(accountId),
			members: core.user.listMembers(unionId),
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
