import { StateError } from "../../../errors/state-error";
import type { WebUIAPI } from "../types";
import { buildServicePayload } from "../service-view";

/**
 * 设置服务插件的启用状态
 *
 * POST
 * 请求体
 * - id: 目标服务插件 id
 * - state: 状态, true or false
 *
 * 与 set_plugin_state 同语义: 先把运行态收敛成功, 再把期望态落盘(失败则拒绝,
 * 文件里不会留下做不到的期望)。依赖连带也会一并生效 —— 停用一个服务会连带
 * 停用依赖它的服务, 启用一个服务会连带启用它依赖的服务, 受影响的 id 在
 * affected 里回传, 前端据此提示。
 *
 * 返回收敛后的完整列表: 连带变更会同时改变多个服务的运行态, 只回单个状态
 * 反而会让前端显示与磁盘脱节。
 */
export default {
	method: "POST",
	path: "set_service_state",
	auth: true,

	async handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const id = `${req.body?.id}`;
		// 严格校验: "false" / 0 这类非布尔值一律拒绝, 免得把客户端的误用静默解释成"启用"
		if (typeof req.body?.state !== "boolean") {
			throw { code: 400, err: "state 必须是布尔值" };
		}
		const state = req.body.state as boolean;

		if (!core.services.resolve(id)) throw { code: 404, err: `目标服务插件不存在: ${id}` };

		try {
			const result = await core.services.setEnabled(id, state);
			return {
				success: true,
				/** 目标服务收敛后的运行态 */
				state: result.enabled,
				/** 被连带启用/停用的服务 id */
				affected: result.affected,
				...buildServicePayload(core.services),
			};
		} catch (e) {
			if (e instanceof StateError) throw { code: 409, err: (e as Error).message };
			throw { code: 500, err: `更改服务插件状态失败: ${(e as Error).message}` };
		}
	},
} as WebUIAPI;
