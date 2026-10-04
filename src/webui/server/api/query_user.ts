import type { WebUIAPI } from "../types";
import { fail, parseTarget, requireCore, requireUser } from "./_shared";

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
		const user = requireUser(requireCore(core));

		const { platform, id } = parseTarget(req.body);

		const accountId = user.find(platform, id);
		if (!accountId) fail(404, `账号不存在: ${platform} ${id}`);

		const unionId = user.getUnion(accountId);
		if (!unionId) fail(404, "该账号未归属任何跨平台ID");

		return {
			platform,
			id,
			accountId,
			unionId,
			lastUnionId: user.getLast(accountId),
			members: user.listMembers(unionId),
		};
	},
};

export default api;
