import type { WebUIAPI } from "../types";
import { fail, parseTarget, requireCore, requireUser } from "./_shared";

/**
 * 指定绑定: 把源账号并入目标账号所在的跨平台ID
 * POST
 * 请求体
 * - source: { platform, id } 被并入的账号
 * - target: { platform, id } 目标账号, 其所在跨平台ID为合并目标
 * - dryRun: true 时只返回影响预览, 不产生变更 (默认 false)
 * 返回
 * - success: 是否发生了变更
 * - alreadyBound: 两账号已在同一跨平台ID下
 * - applied: 本次请求是否真的执行了绑定 (dryRun 时为 false)
 * - sourceGroupSize / targetGroupSize / afterSize: 变更前源组与目标组人数, 以及合并后人数
 *
 * 两个账号都必须已存在 (拒绝为未出现过的账号凭空建档);
 * 跨平台ID 一律由服务端推导, 不接受调用方传入。
 */

const api: WebUIAPI = {
	path: "bind_account",
	method: "POST",
	auth: true,

	handler(req, core) {
		const user = requireUser(requireCore(core));

		const body = (req.body ?? {}) as { source?: unknown; target?: unknown; dryRun?: unknown };
		const source = parseTarget(body.source, "source");
		const target = parseTarget(body.target, "target");
		const dryRun = body.dryRun === true;

		const sourceAccountId = user.find(source.platform, source.id);
		if (!sourceAccountId) {
			fail(404, `源账号不存在: ${source.platform} ${source.id}`);
		}

		const targetAccountId = user.find(target.platform, target.id);
		if (!targetAccountId) {
			fail(404, `目标账号不存在: ${target.platform} ${target.id}`);
		}

		if (sourceAccountId === targetAccountId) {
			fail(400, "不能将账号绑定到其自身");
		}

		const sourceUnionId = user.getUnion(sourceAccountId);
		const targetUnionId = user.getUnion(targetAccountId);
		if (!sourceUnionId || !targetUnionId) {
			fail(500, "读取账号的跨平台ID失败");
		}

		const sourceGroupSize = user.listMembers(sourceUnionId).length;
		const targetGroupSize = user.listMembers(targetUnionId).length;

		// 已在同一组: 不是错误, 告知调用方无需重复操作
		if (sourceUnionId === targetUnionId) {
			return {
				success: false,
				alreadyBound: true,
				applied: false,
				message: "两个账号已在同一个跨平台ID下",
				sourceAccountId,
				targetAccountId,
				targetUnionId,
				sourceGroupSize,
				targetGroupSize,
				afterSize: targetGroupSize,
			};
		}

		if (dryRun) {
			return {
				success: true,
				alreadyBound: false,
				applied: false,
				sourceAccountId,
				targetAccountId,
				targetUnionId,
				sourceGroupSize,
				targetGroupSize,
				afterSize: targetGroupSize + 1,
			};
		}

		user.bind(targetUnionId, sourceAccountId);

		return {
			success: true,
			alreadyBound: false,
			applied: true,
			sourceAccountId,
			targetAccountId,
			targetUnionId,
			sourceGroupSize,
			targetGroupSize,
			afterSize: targetGroupSize + 1,
		};
	},
};

export default api;
