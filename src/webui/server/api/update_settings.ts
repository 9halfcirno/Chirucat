import type { WebUIAPI } from "../types";
import { fail, requireCore, rethrowSettingsError } from "./_shared";

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
		const c = requireCore(core);

		const id = `${req.body?.domain ?? ""}`;
		const domain = c.settings.domain(id);
		if (!domain) fail(404, `设置域 ${id} 不存在`);

		try {
			const result = await domain.patch(req.body?.patch);
			return { success: true, ...result };
		} catch (e) {
			rethrowSettingsError(e, "保存设置");
		}
	},
};

export default api;
