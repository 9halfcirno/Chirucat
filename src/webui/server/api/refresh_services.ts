import type { WebUIAPI } from "../types";
import { buildServicePayload } from "../service-view";

/**
 * 重新扫描服务插件目录并返回最新的服务列表
 *
 * POST (无需请求体)
 *
 * 与 refresh_plugins 同语义: 先扫描磁盘, 再回传结果。
 *
 * 不同之处在扫描之后: 服务插件随时可以加载, 因此这里立刻把运行态收敛到期望态
 * (新丢进 services/ 的插件直接启用)。不收敛的话, 列表会把它显示成"已停用",
 * 而状态文件里根本没停用过它 —— 界面与持久化期望互相矛盾。
 * 收敛失败的 id 放在 failed 里回传, 由前端提示(不阻断列表展示)。
 */
export default {
	method: "POST",
	path: "refresh_services",
	auth: true,

	async handler(_req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		let failed: string[] = [];
		try {
			await core.services.scan();
			failed = await core.services.syncState();
		} catch (e) {
			throw { code: 500, err: `刷新服务插件失败: ${(e as Error).message}` };
		}

		return { success: true, failed, ...buildServicePayload(core.services) };
	},
} as WebUIAPI;
