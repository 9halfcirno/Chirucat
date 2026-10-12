import esbuild, { type Plugin } from "esbuild";
import type { PluginModule } from "./types";
import path from "path";
import module from "module";

const PLUGIN_MODULE_VAR = "__chirucat_plugin_module__";

/**
 * 受限插件禁止导入的内置模块
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
	allowRestrictedBuiltins?: boolean;
}

export class PluginLoader {
	constructor(private readonly option: PluginLoaderOption = {}) { }

	async load<M = PluginModule>(fileURL: string): Promise<{ default: M; }> {
		// 插件根目录：入口文件所在目录，也是 prequire 的解析基准目录
		const pluginRoot = path.dirname(fileURL);
		const prequire = module.createRequire(path.join(pluginRoot, "package.json"))

		const option: esbuild.BuildOptions = {
			bundle: true,
			write: false,
			entryPoints: [fileURL],
			format: "iife",
			platform: "node",
			globalName: PLUGIN_MODULE_VAR,

			plugins: [
				this.createImportResolver(prequire, pluginRoot)
			]
		}

		const output = await esbuild.build(option);

		const code = output.outputFiles?.[0]?.text;
		if (!code) throw new Error(`构建产物为空`)
		return new Function("require", `${code};return ${PLUGIN_MODULE_VAR};`)(prequire) as { default: M };
	}

	/**
	 * 创建用于解决插件导入的 esbuild 插件
	 * @param require  插件目录解析出来的 require
	 * @param pluginRoot 插件根目录(入口文件所在目录), 该目录之外的相对/绝对导入一律视为外部依赖
	 */
	private createImportResolver(require: NodeJS.Require, pluginRoot: string) {
		const self = this;
		const importResolver: Plugin = {
			name: "plugin-import-resolver",
			setup(build) {
				const importMap = new Map<string, string>();
				build.onResolve({ filter: /.*/ }, (args) => {
					const mod = args.path;

					// 1) 内置模块
					if (module.isBuiltin(mod)) {
						if (!self.option.allowRestrictedBuiltins && REFUSE_MODULE.has(mod)) {
							throw new Error(`被拒绝的原生模块: ${mod}`);
						}
						return { external: true };
					}

					// 2) 原生模块 (.node 二进制): 不参与打包, 交给宿主按绝对路径 require
					if (mod.endsWith(".node")) {
						const resolved = self.isNPM(mod)
							? require.resolve(mod)
							: path.resolve(args.resolveDir || pluginRoot, mod);
						return { path: resolved, external: true };
					}

					// 3) npm 包
					if (self.isNPM(mod)) {
						if (importMap.has(mod)) {
							return { path: importMap.get(mod)!, external: true };
						}
						const rpath = require.resolve(mod);
						importMap.set(mod, rpath);
						return { path: rpath, external: true };
					}

					// 4) 相对 / 绝对路径：只要解析后的路径落在插件目录之外,
					//    就当作外部依赖。避免插件写错路径(如 ../../../src/foo)
					//    把框架源码整个打包进插件产物。
					const abs = path.resolve(args.resolveDir || pluginRoot, mod);
					if (!self.isInside(pluginRoot, abs)) {
						throw new Error(`被拒绝的模块: ${abs} 插件仅可导入自身目录下的代码`)
					}

					// 插件目录内部的文件：交给 esbuild 继续打包
					return null;
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

	/** child 是否位于 parent 目录(含自身)之内 */
	private isInside(parent: string, child: string) {
		const rel = path.relative(parent, child);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	}
}