import type { WebUIAPI } from "../types";

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
		if (!core) throw { err: "WebUI未连接到核心", code: 503 };

		const id = `${req.body?.id}`;
		const service = core.services.resolve(id);
		if (!service) throw { code: 404, err: `服务插件 ${id} 不存在` };

		if (!service.config) {
			await core.services.setupConfig(service);
			if (!service.config) throw { code: 404, err: `服务插件 ${id} 没有可用的配置` };
		}

		const config = service.config;

		// 校验不通过不落盘; details 带上字段级错误, 供前端定位到具体控件
		const errors = config.vaildate(req.body?.config);
		if (errors.length) {
			const detail = errors
				.map(e => `${e.path || "配置"}: ${e.message}`)
				.join("; ");
			throw { code: 400, err: `配置校验未通过: ${detail}`, details: errors };
		}

		try {
			await config.update(req.body?.config);
		} catch (e) {
			throw { code: 500, err: `保存服务插件配置失败: ${(e as Error).message}` };
		}

		// 回传规范化后的值: 隐藏项、缺失键已被补齐, 便于前端与后端对齐
		return { success: true, config: config.data };
	},
} as WebUIAPI;
