/**
 * 插件导入边界检查
 *
 * PluginLoader 在运行时会拒绝插件引用自身目录之外的代码, 但那只在插件真正加载时
 * 才生效 —— 写错路径的插件要等到部署后才暴露。这里用同一套 resolver 做一次纯静态的
 * 构建检查(不执行产物), 让 check:plugins 就能发现越界导入。
 *
 * 检查口径与 PluginLoader 一致:
 * - 插件自身目录内的文件: 允许(会被打包);
 * - npm 包、Node 内置模块: 允许(内置模块按 loader 的受限清单判定);
 * - 相对/绝对路径解析后落在插件目录之外: 拒绝;
 * - `import type` 参与不了打包, esbuild 直接擦除, 因此不受此限制
 *   (插件仍可从框架取类型, 这与运行时行为一致)。
 *
 * 用法: tsx scripts/check-plugin-imports.ts
 */
import fs from "node:fs";
import path from "node:path";
import json5 from "json5";
import { PluginLoader } from "../src/plugin/loader";
import { root } from "../src/utils/root";

type Target = {
	kind: "plugin" | "service";
	dir: string;
	entry: string;
};

/** 扫描 plugins/ 与 services/ 下的清单, 收集各插件入口 */
function collect(): { targets: Target[]; errors: string[] } {
	const targets: Target[] = [];
	const errors: string[] = [];

	const scan = (base: string, kind: Target["kind"]) => {
		if (!fs.existsSync(base)) return;
		for (const name of fs.readdirSync(base, { withFileTypes: true })) {
			if (!name.isDirectory()) continue;
			const dir = path.join(base, name.name);
			const manifestPath = path.join(dir, "manifest.json");
			if (!fs.existsSync(manifestPath)) continue;

			try {
				// 与框架的清单读取保持一致: 用 json5 解析(容忍 BOM/注释/尾逗号)
				const manifest = json5.parse(fs.readFileSync(manifestPath, "utf8")) as { main?: string };
				if (!manifest.main) {
					errors.push(`${path.relative(root, dir)}: 清单缺少 main 字段`);
					continue;
				}
				const entry = path.resolve(dir, manifest.main);
				if (!fs.existsSync(entry)) {
					errors.push(`${path.relative(root, entry)}: 入口文件不存在`);
					continue;
				}
				targets.push({ kind, dir, entry });
			} catch (e) {
				errors.push(`${path.relative(root, dir)}: 读取清单失败 (${e instanceof Error ? e.message : e})`);
			}
		}
	};

	scan(path.join(root, "plugins"), "plugin");
	scan(path.join(root, "services"), "service");
	return { targets, errors };
}

const { targets, errors } = collect();
let passed = 0;
let failed = 0;

for (const target of targets) {
	// 服务插件属于框架级可信插件, 与 ServiceHost 的做法一致地放开受限内置模块
	const loader = new PluginLoader({ allowRestrictedBuiltins: target.kind === "service" });
	const label = path.relative(root, target.dir);

	try {
		await loader.verify(target.entry);
		passed++;
		console.log(`  PASS  ${label}`);
	} catch (e) {
		failed++;
		const message = e instanceof Error ? e.message : String(e);
		console.log(`  FAIL  ${label}\n        ${message.replaceAll("\n", "\n        ")}`);
	}
}

for (const error of errors) {
	failed++;
	console.log(`  FAIL  ${error}`);
}

console.log(`\n导入边界: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
