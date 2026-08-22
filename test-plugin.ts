import fs from "fs/promises";
import path from "path";
import { root } from "./src/utils/root";
import { PluginManager } from "./src/plugin/manager";

const TMP = path.resolve(root, "tmp-plugin-test");

function assert(cond: boolean, msg: string) {
	if (!cond) throw new Error("断言失败: " + msg);
	console.log("[OK]   " + msg);
}

async function expectError(label: string, fn: () => Promise<unknown>) {
	try {
		await fn();
		console.log(`[FAIL] ${label}: 未抛出错误`);
	} catch (err) {
		console.log(`[OK]   ${label} → ${(err as Error).message}`);
	}
}

async function writePlugin(base: string, id: string, extra: Record<string, unknown>, code: string) {
	const dir = path.join(TMP, base, id);
	await fs.mkdir(dir, { recursive: true });
	const manifest = { id, version: "0.0.0", main: "index.js", ...extra };
	await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, "\t"));
	await fs.writeFile(path.join(dir, "index.js"), code);
}

async function main() {
	// —— 临时插件准备 ——
	await fs.mkdir(TMP, { recursive: true });
	await writePlugin("normal", "a-ok", {},
		`export default { init(ctx){ console.log("a-ok init"); }, unload(){ console.log("a-ok unload"); } }`);
	await writePlugin("normal", "d-dep", { dependencies: { "a-ok": "=0.0.0" } },
		`export default { init(ctx){ console.log("d-dep init"); }, unload(){ console.log("d-dep unload"); } }`);
	await writePlugin("fail-static", "c-missing", { dependencies: { "nope": "=0.0.0" } },
		`export default { init(){ console.log("c-missing init"); } }`);
	await writePlugin("fail-runtime", "a-ok", {},
		`export default { init(){ console.log("a-ok init"); }, unload(){ console.log("a-ok unload"); } }`);
	await writePlugin("fail-runtime", "b-boom", { dependencies: { "a-ok": "=0.0.0" } },
		`export default { init(){ throw new Error("boom"); } }`);

	const pluginsDir = path.resolve(root, "plugins");

	// —— 1. scan 只扫描, 不加载 ——
	{
		const mgr = new PluginManager();
		await mgr.scan(pluginsDir);
		console.log("1. roots:", mgr.roots.map(n => n.manifest.id).join(", "));
		console.log("1. topoOrder:", mgr.topoOrder.map(n => n.manifest.id).join(" -> "));
		assert(mgr.plugins.size === 0, "scan 不加载任何插件");
		assert(mgr.roots.length === 1 && mgr.roots[0]!.manifest.id === "des", "树根应为 des");

		// —— 2. load() 全部: 拓扑序 des → ping ——
		console.log("2. load() 全部:");
		await mgr.load();
		assert([...mgr.plugins.keys()].join(",") === "des,ping", "load 后包含 des,ping");
		assert(mgr.topoOrder[0]!.state === "loaded" && mgr.topoOrder[1]!.state === "loaded", "全部 loaded");

		// —— 3. unload("des") 强制卸载子树 ——
		console.log("3. unload('des') 强制卸载子树:");
		await mgr.unload("des");
		assert(mgr.plugins.size === 0, "卸载 des 后无残留插件");

		// —— 4. load("ping") 按需加载依赖链 ——
		console.log("4. load('ping') 按需加载:");
		await mgr.load("ping");
		assert([...mgr.plugins.keys()].join(",") === "des,ping", "load('ping') 加载 des+ping");

		// —— 5. unload("ping") 只卸 ping, des 保留 ——
		console.log("5. unload('ping'):");
		await mgr.unload("ping");
		assert([...mgr.plugins.keys()].join(",") === "des", "卸载 ping 后只剩 des");
	}

	// —— 6. 静态失败: 依赖缺失 → scan 抛错 ——
	{
		const mgr = new PluginManager();
		await expectError("scan 依赖缺失", () => mgr.scan(path.join(TMP, "fail-static")));
		assert(mgr.plugins.size === 0 && mgr.nodes.size === 0, "静态失败后无任何注册/加载");
	}

	// —— 7. 运行时失败: init 抛错 → load 抛错并回滚 ——
	{
		const mgr = new PluginManager();
		await mgr.scan(path.join(TMP, "fail-runtime"));
		console.log("7. load() 期望失败并回滚:");
		await expectError("load init 抛错", () => mgr.load());
		assert(mgr.plugins.size === 0, "失败后回滚, 无残留插件");
		assert(mgr.nodes.get("a-ok")!.state === "unloaded", "依赖 a-ok 已回滚为 unloaded");
		assert(mgr.nodes.get("b-boom")!.state === "error", "b-boom 标记为 error");
	}

	// —— 8. 强制卸载顺序: 叶 → 目标 (unload log 验证) ——
	{
		const mgr = new PluginManager();
		await mgr.scan(path.join(TMP, "normal"));
		await mgr.load();
		console.log("8. unload('a-ok') 期望顺序 d-dep → a-ok:");
		await mgr.unload("a-ok");
		assert(mgr.plugins.size === 0, "卸载 a-ok 子树后无残留");
	}

	// —— 9. 重复扫描: 收集新插件, 已加载插件保持 loaded ——
	{
		const mgr = new PluginManager();
		const base = path.join(TMP, "rescan");
		await writePlugin("rescan", "a-ok", {},
			`export default { init(ctx){ console.log("a-ok init"); }, unload(){ console.log("a-ok unload"); } }`);
		await mgr.scan(base);
		await mgr.load();
		assert([...mgr.plugins.keys()].join(",") === "a-ok", "首次加载 a-ok");

		// 往同一目录新增插件 b-new (依赖已加载的 a-ok)
		await writePlugin("rescan", "b-new", { dependencies: { "a-ok": "=0.0.0" } },
			`export default { init(ctx){ console.log("b-new init"); }, unload(){ console.log("b-new unload"); } }`);
		console.log("9. 重复扫描收集新插件:");
		await mgr.scan(base);
		assert(mgr.plugins.size === 1 && mgr.plugins.has("a-ok"), "重复扫描后已加载插件保持");
		assert(mgr.nodes.get("b-new")!.state === "registered", "新插件注册为 registered");
		console.log("9. rescan topoOrder:", mgr.topoOrder.map(n => n.manifest.id).join(" -> "));

		await mgr.load();
		assert([...mgr.plugins.keys()].join(",") === "a-ok,b-new", "再次 load 收集新插件");
		await mgr.unload("b-new");
		assert([...mgr.plugins.keys()].join(",") === "a-ok", "卸载 b-new 后 a-ok 保留");
	}

	// —— 10. 已加载插件目录消失 → scan 抛错保护 ——
	{
		const mgr = new PluginManager();
		const base = path.join(TMP, "rescan-gone");
		await writePlugin("rescan-gone", "a-ok", {},
			`export default { init(ctx){}, unload(){} }`);
		await mgr.scan(base);
		await mgr.load();
		assert(mgr.plugins.has("a-ok"), "已加载 a-ok");
		await fs.rm(path.join(base, "a-ok"), { recursive: true, force: true });
		await expectError("已加载插件消失时 scan 报错", () => mgr.scan(base));
		assert(mgr.plugins.has("a-ok"), "报错后已加载插件不受影响");
	}

	// —— 清理 ——
	await fs.rm(TMP, { recursive: true, force: true });
	console.log("\n全部通过 ✅");
}

main().catch(err => {
	console.error("测试失败:", err);
	process.exitCode = 1;
});
