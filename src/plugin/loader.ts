import esbuild from "esbuild";

export class PluginLoader {
	/**
	 * 构建插件代码并导出插件模块
	 * @param filename 
	 */
	async load(filename: string) {
		const option: esbuild.BuildOptions = {
			bundle: true,
			write: false,
			entryPoints: [filename],
			format: "iife",
			platform: "node",
			globalName: "module"
		}

		const output = await esbuild.build(option);

		const code = output.outputFiles?.[0]?.text;
		if (!code) throw new Error(`构建产物为空`)
		return new Function(`${code};return module;`)();

	}

	/**
	 * 检查是否为合法导入
	 * @param url 模块绝对路径
	 */
	private _availableImport(url: string): boolean {
		return false;
	}
}