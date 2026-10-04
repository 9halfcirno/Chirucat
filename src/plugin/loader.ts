import esbuild, { type Plugin } from "esbuild";
import type { NPMPackages, PluginModule } from "./types";
import path from "path";
import module from "module";

const PLUGIN_MODULE_VAR = "__chirucat_plugin_module__";

/**
 * 受限插件禁止导入的内置模块
 *
 * 按完整模块名列举(含 `node:` 前缀的两种写法), 按风险分组。插件应有对应的
 * 受控替代品, 而不是直接拿到宿主的原生能力:
 *
 * - 文件系统: 改用 `ctx.fs`(有根目录约束与越界保护)
 * - 进程/系统: 能执行任意命令或读取宿主信息, 直接突破沙箱
 * - 原始网络: 需要联网时用全局 `fetch` / `WebSocket`(Node 18+ 内置,
 *   它们不是模块导入, 不经过这里)
 * - 沙箱逃逸: worker / cluster 能另起执行环境, 绕过本列表
 *
 * 曾经只列 "fs"/"node:fs", 于是 "fs/promises" 作为另一个内置模块被放行,
 * 受限插件照样能拿到文件系统; 同样的缺口存在于 child_process / os / net 等 ——
 * `import { exec } from "child_process"` 之前是畅通的。
 */
const REFUSE_MODULE = new Set([
	// 文件系统
	"fs", "node:fs",
	"fs/promises", "node:fs/promises",
	// 进程与系统信息
	"child_process", "node:child_process",
	"child_process/promises", "node:child_process/promises",
	// 待评估 "os", "node:os",
	// 原始网络
	// 待评估 "net", "node:net",
	"dgram", "node:dgram",
	// 待评估 "http", "node:http",
	// 待评估 "https", "node:https",
	// 待评估 "tls", "node:tls",
	// 沙箱逃逸
	"worker_threads", "node:worker_threads",
	"cluster", "node:cluster",
]);

export type PluginLoaderOption = {
	/**
	 * 是否允许导入受限内置模块(fs 等), 缺省 false
	 *
	 * 服务插件(services/)属于框架级可信代码, 需要在宿主进程里做真实基础设施
	 * (监听文件、起服务、连数据库), 因此放开; 普通插件维持受限。
	 */
	allowRestrictedBuiltins?: boolean;
}

export class PluginLoader {
	constructor(private readonly option: PluginLoaderOption = {}) { }

	/**
	 * 构建插件代码并导出插件模块
	 *
	 * 泛型参数用于区分宿主: 普通插件用默认的 PluginModule, 服务插件传 `PluginModule<ServiceContext>`
	 * (构建产物不在编译期检查之列, 这里只是把“同一个模块契约、不同上下文”表达出来)。
	 * @param fileURL 入口文件
	 */
	async load<M = PluginModule>(fileURL: string): Promise<{ default: M; }> {
		const prequire = module.createRequire(path.join(path.dirname(fileURL), "package.json"))

		const option: esbuild.BuildOptions = {
			bundle: true,
			write: false,
			entryPoints: [fileURL],
			format: "iife",
			platform: "node",
			globalName: PLUGIN_MODULE_VAR,

			plugins: [
				this.createImportResolver(prequire)
			]
		}

		const output = await esbuild.build(option);

		const code = output.outputFiles?.[0]?.text;
		if (!code) throw new Error(`构建产物为空`)
		return new Function("require", `${code};return ${PLUGIN_MODULE_VAR};`)(prequire) as { default: M };

	}


	/**
	 * 创建用于解决插件导入的esbuild插件
	 * @param root 插件模块根目录
	 * @returns 
	 */
	private createImportResolver(require: NodeJS.Require) {
		const self = this;
		const importResolver: Plugin = {
			name: "plugin-import-resolver",
			setup(build) {
				const importMap = new Map<string, string>();
				build.onResolve({ filter: /.*/ }, (args) => {
					let mod = args.path;
					if (module.isBuiltin(mod)) {
						if (!self.option.allowRestrictedBuiltins && REFUSE_MODULE.has(mod)) throw new Error(`被拒绝的原生模块: ${mod}`);
						return {
							external: true // 内置模块返回
						}
					}
					// 原生模块(.node 二进制): 不参与打包, 交给宿主按绝对路径 require。
					// 否则 esbuild 会把二进制当普通文件处理而构建失败
					if (mod.endsWith(".node")) {
						const resolved = self.isNPM(mod)
							? require.resolve(mod) // npm 包内的子路径, 由插件目录解析
							: path.resolve(args.resolveDir || ".", mod);
						return {
							path: resolved,
							external: true
						};
					}
					if (self.isNPM(args.path)) {
						if (importMap.has(mod)) return {
							path: importMap.get(mod)!,
							external: true
						};
						// 未命中缓存
						const rpath = require.resolve(mod); // 解决npm包
						importMap.set(mod, rpath);
						return {
							path: rpath,
							external: true
						}
					} else { // 不是npm包
						return null; // 先放行
					}

				})
			}
		}
		return importResolver;
	}

	private isNPM(url: string) {
		return !url.startsWith(".")
			&& !url.startsWith("/")
			&& !path.isAbsolute(url);
	}
}


