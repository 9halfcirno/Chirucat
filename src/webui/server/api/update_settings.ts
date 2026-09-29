import { SettingsApplyError } from "../../../config/settings/manager";
import { SettingsError } from "../../../config/settings/types";
import type { WebUIAPI } from "../types";

/**
 * 写入一个设置域
 *
 * POST
 * 请求体
 * - domain: 目标设置域 id
 * - patch: 改动 (前端 config-editor 的 getValues() 输出; 未提交的字段保留原值)
 *
 * 校验不通过不落盘, details 带字段级错误供前端定位到具体控件。
 * 返回 `restartRequired`: 这些字段已保存但**需重启 Core 才生效** —— 前端要如实提示,
 * 不能谎报"已生效"。
 */
const api: WebUIAPI = {
	path: "update_settings",
	method: "POST",
	auth: true,

	async handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const id = `${req.body?.domain ?? ""}`;
		const domain = core.settings.domain(id);
		if (!domain) throw { err: `设置域 ${id} 不存在`, code: 404 };

		try {
			const result = await domain.patch(req.body?.patch);
			return { success: true, ...result };
		} catch (e) {
			// 字段级校验错误: 让前端能把错误落到具体控件上
			if (e instanceof SettingsError) {
				throw { err: e.message, code: 400, details: e.details };
			}
			// 值已落盘、只是热应用没成功: 报"存住了但没生效", 不要笼统地说保存失败
			if (e instanceof SettingsApplyError) {
				throw {
					err: e.message,
					code: 500,
					details: { values: e.outcome.values, changed: e.outcome.changed },
				};
			}
			throw { err: `保存设置失败: ${e instanceof Error ? e.message : String(e)}`, code: 500 };
		}
	},
};

export default api;
