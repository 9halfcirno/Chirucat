import type { WebUIAPI } from "../types";

/**
 * 服务插件页面清单
 *
 * GET
 * 返回
 * - version: 清单版本号 (每次增删页面都会变)
 * - pages: 已拼好 URL 的页面条目 (`scope: "app"` 进活动栏, `"bot"` 进 Bot 详情窗口)
 *
 * 这是前端**唯一的真相来源**: 前端拿它做幂等对账(注册新页面、注销已消失的页面、
 * 更新变了的定义), 因此"服务停用即导航消失"不需要额外的推送通道 —— 只要在服务
 * 启停之后重新拉一次即可(见 js/spa/service-pages.js)。
 *
 * 模块 URL 带 `?v=<版本>`: ES 模块按 URL 永久缓存, 停用再启用必须换一个地址才能
 * 拿到新代码。
 *
 * WebUI 脱离 Core 独立运行时没有服务插件, 回空清单。
 */
export default {
	method: "GET",
	path: "get_webui_pages",
	auth: true,

	handler(_req, core) {
		const server = core?.webui;
		if (!server) return { version: 0, pages: [] };

		return {
			version: server.servicePagesVersion,
			pages: server.getServicePages(),
		};
	},
} as WebUIAPI;
