import type { WebUIAPI } from "../types";
import { fail, requireCore, requirePluginConfig, savePluginConfig } from "./_shared";

/**
 * 更新服务插件配置
 *
 * POST
 * 请求体
 * - id: 目标服务插件 id
 * - config: 配置值 (前端 config-editor 的 getValues() 输出)
 *
 * 与 update_plugin_config 同语义: 以插件的配置定义(manifest.config)为骨架合并,
 * 提交里缺失的已知键保留旧值 —— 前端不产出隐藏项, 直接覆盖会把隐藏项抹掉。
 * 值文件是全局的: configs/services/<插件id>.json。
 */
export default {
	method: "POST",
	path: "update_service_config",
	auth: true,

	async handler(req, core) {
		const c = requireCore(core);

		const id = `${req.body?.id}`;
		const service = c.services.resolve(id);
		if (!service) fail(404, `服务插件 ${id} 不存在`);

		const { config } = await requirePluginConfig(
			service, "服务插件", (s) => c.services.setupConfig(s));

		return savePluginConfig(config, req.body?.config, `服务插件 ${id}`);
	},
} as WebUIAPI;
