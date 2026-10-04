import type { WebUIAPI } from "../types";
import { fail, parseTarget, requireCore, requireUser } from "./_shared";

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
		const user = requireUser(requireCore(core));

		const { platform, id } = parseTarget(req.body);

		const accountId = user.find(platform, id);
		if (!accountId) fail(404, `账号不存在: ${platform} ${id}`);

		if (!user.getLast(accountId)) {
			fail(400, "该账号没有可恢复的上一个跨平台ID");
		}

		const unionId = user.restore(accountId);
		if (!unionId) fail(409, "恢复失败: 该账号当前已在该跨平台ID下");

		return {
			accountId,
			unionId,
			lastUnionId: user.getLast(accountId),
		};
	},
};

export default api;
