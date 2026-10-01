/**
 * 测试用的模块解析钩子: 让 Node 也能按浏览器的语义解析插件前端的绝对路径 import
 *
 * 插件自带的前端模块(`services/<插件>/public/**`)按浏览器规则写 import:
 *
 * ```js
 * import { callServiceAPI } from "/js/spa/api.js";   // 绝对路径 = 核心前端
 * import { renderFilterView } from "./filter-view.js"; // 相对路径 = 同目录的插件文件
 * ```
 *
 * Node 的 ESM 加载器会把 `/js/...` 当成"文件系统根下的 /js/..."(或者干脆拒绝), 因此
 * 插件模块在 Node 里 import 不起来 —— 而这条路径恰恰是最值得在无浏览器环境里验证的
 * 一环(迁移/改名后路径写错, 只有真 import 一次才发现)。
 *
 * 这里把 `/js/**` 与 `/img/**` 映射到核心前端静态目录, 与浏览器的解析结果一致;
 * 其余说明符照常交给默认解析器。
 *
 * 用法(在安装好 DOM 桩之后、import 插件模块之前):
 *
 * ```js
 * import { register } from "node:module";
 * register("./plugin-frontend-import-map.mjs", import.meta.url);
 * ```
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 核心前端静态目录, 等价于 WebUI 服务器里的 staticDir */
const webRoot = pathToFileURL(path.resolve("src", "webui", "public") + path.sep).href;

export async function resolve(specifier, context, next) {
	if (specifier.startsWith("/js/") || specifier.startsWith("/img/")) {
		return { url: new URL(specifier.replace(/^\//, ""), webRoot).href, shortCircuit: true };
	}
	return next(specifier, context);
}
