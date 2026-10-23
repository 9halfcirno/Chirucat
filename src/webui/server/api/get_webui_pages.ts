import type { WebUIAPI } from "../types";

/**
 * WebUI 页面清单
 *
 * GET
 * 返回
 * - version: 服务插件页面清单的版本号 (每次增删页面都会变, 模块 URL 的 `?v=` 也用它)
 * - corePagesVersion: 核心可选页面清单的版本号 (任一可选页面的开关变化时变)
 * - pages: 服务插件页面条目 (`scope: "app"` 进活动栏, `"bot"` 进 Bot 详情窗口)
 * - corePages: 核心可选页面条目 (统计页 / 测试页, `before` 指定插在哪个页面之前)
 *
 * 这是前端**唯一的真相来源**: 前端拿它做幂等对账(注册新页面、注销已消失的页面、
 * 更新变了的定义), 因此"统计模块停用 / 测试页关闭 / 服务停用即导航消失"不需要
 * 额外的推送通道 —— 只要在设置保存、服务启停之后重新拉一次即可
 * (见 js/spa/service-pages.js)。
 *
 * 服务插件页面的模块 URL 带 `?v=<version>`: ES 模块按 URL 永久缓存, 停用再启用
 * 必须换一个地址才能拿到新代码。核心页面用静态路径, 不需要版本参数。
 *
 * WebUI 脱离 Core 独立运行时没有页面, 回空清单。
 */
export default {
	method: "GET",
	path: "get_webui_pages",
	auth: true,

	handler(_req, core) {
		const server = core?.webui;
		if (!server) {
			return { version: 0, corePagesVersion: 0, pages: [], corePages: [] };
		}

		// 核心可选页面: 依赖可选模块 / 前端开关, 不满足时条目直接从清单消失,
		// 前端下一次对账会注销它
		const testLab = server.front?.enableTestLab === true;
		const corePages = [];
		if (core.statistics) {
			corePages.push({
				key: "stats",
				scope: "app",
				title: "统计",
				icon: "/img/icons/stats.svg",
				module: "/js/pages/stats/stats.js",
				before: "bots",
				order: 0,
				menu: [],
			});
		}
		if (testLab) {
			corePages.push({
				key: "test",
				scope: "app",
				title: "测试页面",
				icon: "/img/icons/test.svg",
				module: "/js/pages/test/index.js",
				before: "logs",
				order: 0,
				menu: [],
			});
		}

		return {
			version: server.servicePagesVersion,
			corePagesVersion: (core.statistics ? 1 : 0) | (testLab ? 2 : 0),
			pages: server.getServicePages(),
			corePages,
		};
	},
} as WebUIAPI;
