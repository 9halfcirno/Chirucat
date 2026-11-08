/**
 * Plugin / Service 的 enable-disable 状态机自检
 *
 * 状态管理重构第 0 批的基线之一: 第 3 批要把这两个目前几乎逐行相同的类合成
 * 泛型实体, 先把状态机语义(含失败时的分工)逐条钉住, 并断言两者完全一致。
 *
 * 关键契约: enable/disable **失败时只做清理**, 终态由宿主(PluginManager /
 * ServiceHost)恢复到加载前的关态 —— 单元层不引入第三种状态。
 *
 * 用法:
 *   npx tsx scripts/check-entity-state.ts
 *
 * 不创建任何文件、不启动 Core; 退出码 0 表示全部通过。
 */
import { Plugin } from "../src/plugin/plugin";
import { Service } from "../src/plugin/services/service";
import type { PluginManifest } from "../src/plugin/types";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ""}`);
	}
}

async function rejects(fn: () => Promise<unknown>, fragment: string): Promise<boolean> {
	try {
		await fn();
		return false;
	} catch (e) {
		return e instanceof Error && e.message.includes(fragment);
	}
}

/** 两个类共有的那部分形状; 用结构化视角跑同一套断言 */
type Entity = {
	status: string;
	module: any;
	context: any;
	config: any;
	configSchema: any;
	enable(ctx?: any): Promise<void>;
	disable(destroy?: boolean): Promise<void>;
};

type EntityFactory = (module: any) => Entity;

const manifest = {
	id: "probe", version: "0.0.0", main: "index.ts", path: ".",
} satisfies PluginManifest;

const makePlugin: EntityFactory = (module) => {
	const p = new Plugin({ manifest, scope: "global", bot: { id: "probe-bot" } as never });
	p.module = module;
	return p as unknown as Entity;
};

const makeService: EntityFactory = (module) => {
	const s = new Service({ manifest: { ...manifest, type: "service" }, core: {} as never });
	s.module = module;
	return s as unknown as Entity;
};

/** 最小上下文替身: 只实现状态机用到的 dispose, 并计数 */
function makeCtx() {
	const state = { disposed: 0 };
	const ctx = { dispose: async () => { state.disposed++; } };
	return { ctx, state };
}

/**
 * 对一类实体跑完整状态机断言。
 * 除了打印结果, 还把每条断言的布尔值原样返回, 供最后比较两类实体是否同构。
 */
async function runSuite(label: string, make: EntityFactory): Promise<boolean[]> {
	console.log(`\n[${label} 状态机]`);
	const results: boolean[] = [];
	const record = (name: string, ok: boolean, detail = ""): void => {
		results.push(ok);
		check(`${label}: ${name}`, ok, detail);
	};

	/* 初始态与幂等 */
	const e1 = make({ init: async () => {} });
	record("初始状态是 registered", e1.status === "registered");
	await e1.disable();
	record("registered 时 disable 幂等", e1.status === "registered");

	/* 缺少前置条件 */
	const noModule = make(null);
	record("模块未加载时 enable 抛错",
		await rejects(() => noModule.enable(makeCtx().ctx), "模块未加载"));
	const noCtx = make({ init: async () => {} });
	record("无运行上下文时 enable 抛错",
		await rejects(() => noCtx.enable(), "无运行上下文"));

	/* 成功启用与幂等 */
	let initCalls = 0;
	const e2 = make({ init: async () => { initCalls++; } });
	const c2 = makeCtx();
	await e2.enable(c2.ctx);
	record("成功启用后进入 enabled", e2.status === "enabled");
	record("init 只调用一次", initCalls === 1);
	record("上下文挂到实体上", e2.context === c2.ctx);
	await e2.enable();
	record("enable 幂等(不重复 init)", initCalls === 1 && e2.status === "enabled");

	e2.status = "unloading";
	record("unloading 期间 enable 被拒", await rejects(() => e2.enable(), "正在切换状态"));
	e2.status = "enabled";

	/* init 失败: 清理 + 异常透传 + 终态留给宿主 */
	const initErr = new Error("init boom");
	let errorSeen: unknown = null;
	const e3 = make({
		init: async () => { throw initErr; },
		error: async (e: unknown) => { errorSeen = e; },
	});
	const c3 = makeCtx();
	record("init 抛错时异常透传", await rejects(() => e3.enable(c3.ctx), "init boom"));
	record("error 钩子收到原始错误", errorSeen === initErr);
	record("失败时释放上下文并置空", c3.state.disposed === 1 && e3.context === null);
	record("失败终态留给调用方(仍是 loading)", e3.status === "loading");
	e3.status = "registered";
	let retried = 0;
	e3.module = { init: async () => { retried++; } };
	await e3.enable(makeCtx().ctx);
	record("宿主恢复关态后可重新启用", e3.status === "enabled" && retried === 1);

	/* 卸载 */
	let unloadCalls = 0;
	const e4 = make({ init: async () => {}, unload: async () => { unloadCalls++; } });
	const c4 = makeCtx();
	await e4.enable(c4.ctx);
	e4.config = { fake: true };
	e4.configSchema = { fake: true };
	await e4.disable();
	record("disable 后进入 disabled", e4.status === "disabled");
	record("unload 被调用一次", unloadCalls === 1);
	record("上下文被释放并置空", c4.state.disposed === 1 && e4.context === null);
	record("配置项一并清空", e4.config === null && e4.configSchema === null);
	record("disable(false) 保留模块", e4.module !== null);
	await e4.disable();
	record("disable 幂等", unloadCalls === 1);

	const e5 = make({ init: async () => {}, unload: async () => {} });
	await e5.enable(makeCtx().ctx);
	await e5.disable(true);
	record("disable(true) 销毁模块", e5.module === null);

	/* unload 抛错: 仍要清理干净 */
	const unloadErr = new Error("unload boom");
	let unloadErrorSeen: unknown = null;
	const e6 = make({
		init: async () => {},
		unload: async () => { throw unloadErr; },
		error: async (e: unknown) => { unloadErrorSeen = e; },
	});
	const c6 = makeCtx();
	await e6.enable(c6.ctx);
	await e6.disable();
	record("unload 抛错仍走 error 钩子", unloadErrorSeen === unloadErr);
	record("unload 抛错仍完成清理与状态收敛",
		c6.state.disposed === 1 && e6.context === null && e6.status === "disabled");

	/* 切换中状态 */
	const e7 = make({ init: async () => {} });
	e7.status = "loading";
	record("loading 期间 disable 被拒", await rejects(() => e7.disable(), "正在切换状态"));

	return results;
}

const pluginResults = await runSuite("Plugin", makePlugin);
const serviceResults = await runSuite("Service", makeService);

console.log("\n[两类实体同构性]");
check("Plugin 与 Service 的状态机断言逐条一致(泛型合并的前提)",
	pluginResults.length === serviceResults.length
	&& pluginResults.every((v, i) => v === serviceResults[i]),
	`Plugin=${pluginResults.length} 条, Service=${serviceResults.length} 条`);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
