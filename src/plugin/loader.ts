import esbuild, { type Plugin } from "esbuild";
import type { NPMPackages, PluginModule } from "./types";
import path from "path";
import module from "module";

export class PluginLoader {
	/**
	 * 构建插件代码并导出插件模块
	 * @param fileURL 
	 */
	async load(fileURL: string): Promise<{ default: PluginModule; }> {
		const prequire = module.createRequire(path.join(path.dirname(fileURL), "packages.json"))

		const option: esbuild.BuildOptions = {
			bundle: true,
			write: false,
			entryPoints: [fileURL],
			format: "iife",
			platform: "node",
			globalName: "module",

			plugins: [
				this.createImportResolver(prequire)
			]
		}

		const output = await esbuild.build(option);

		const code = output.outputFiles?.[0]?.text;
		if (!code) throw new Error(`构建产物为空`)
		return new Function("require", `${code};return module;`)(prequire);

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
					if (module.isBuiltin(mod)) return {
						external: true // 内置模块返回
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


