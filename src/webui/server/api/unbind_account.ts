import type { WebUIAPI } from "../types";
import { fail, parseTarget, requireCore, requireUser } from "./_shared";

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
		const user = requireUser(requireCore(core));

		const { platform, id } = parseTarget(req.body);

		const accountId = user.find(platform, id);
		if (!accountId) fail(404, `账号不存在: ${platform} ${id}`);

		const unionId = user.getUnion(accountId);
		if (!unionId) fail(404, "该账号未归属任何跨平台ID");

		if (!user.unbind(unionId, accountId)) {
			fail(409, "解绑失败: 该账号不在指定的跨平台ID下");
		}

		const newUnionId = user.getUnion(accountId);
		if (!newUnionId) fail(500, "解绑后读取跨平台ID失败");

		return {
			accountId,
			unionId: newUnionId,
			lastUnionId: user.getLast(accountId),
		};
	},
};

export default api;
