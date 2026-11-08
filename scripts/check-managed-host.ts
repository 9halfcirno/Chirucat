/**
 * ManagedHostBase 自检
 *
 * 状态管理重构第 3 批: PluginManager 与 ServiceHost 合流后, 直接对泛型宿主基类
 * 跑一套最小契约断言 —— 不依赖真实 Bot / Core / 插件文件, 用一个探针宿主把
 * 每个策略方法替换成可观测的替身。
 *
 * 覆盖: 双表迭代与查找顺序、依赖图(缺失/豁免/环/按序)、load 调用链与失败回滚、
 * Hook 取消、递归卸载与导出释放、convergeState 先卸后装 + failed[] + 跳过理由、
 * scanDir 对账(清单过滤/重建条件/悬空清理/活跃实例保留)、配置装配、事件派发。
 *
 * 用法:
 *   npx tsx scripts/check-managed-host.ts
 *
 * 全程使用系统临时目录; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigManager } from "../src/config/manager";
import type { ConfigRoot } from "../src/config/types";
import { ManagedHostBase, type HostContextLike, type ManagedEntityLike } from "../src/plugin/managed-host";
import type { PluginManifest, PluginModule, PluginStatus } from "../src/plugin/types";
import type Logger from "../src/utils/logger";

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chirucat-managed-host-"));

/** 记录 warn/error, 不往控制台打日志 */
const logs: string[] = [];
const stubLogger = {
	log: () => {},
	warn: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
	error: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
} as unknown as Logger;

class ProbeContext implements HostContextLike {
	disposed = 0;
	messages: unknown[] = [];
	events = 0;
	async dispose(): Promise<void> { this.disposed++; }
	handleMessage(msg: unknown): void { this.messages.push(msg); }
	handlePlatformEvent(): void { this.events++; }
}

class ProbeEntity implements ManagedEntityLike<ProbeContext> {
	readonly id: string;
	manifest: PluginManifest;
	status: PluginStatus = "registered";
	context: ProbeContext | null = null;
	module: PluginModule<ProbeContext> | null = null;
	configSchema: ConfigRoot | null = null;
	config: ConfigManager | null = null;

	constructor(manifest: PluginManifest) {
		this.id = manifest.id;
		this.manifest = manifest;
	}

	async enable(ctx?: ProbeContext): Promise<void> {
		if (ctx) this.context = ctx;
		await (this.module?.init(this.context!) ?? Promise.resolve());
		this.status = "enabled";
	}

	async disable(destroy = false): Promise<void> {
		await this.context?.dispose();
		this.context = null;
		if (destroy) this.module = null;
		this.status = "disabled";
	}
}

const manifestOf = (id: string, dependencies: Record<string, string> = {}, extra: Partial<PluginManifest> = {}): PluginManifest => ({
	id, version: "0.0.0", main: "index.ts", path: tmp, dependencies, ...extra,
}) as PluginManifest;

class ProbeHost extends ManagedHostBase<ProbeEntity, ProbeContext> {
	readonly regA = new Map<string, ProbeEntity>();
	readonly regB = new Map<string, ProbeEntity>();
	readonly trace: string[] = [];

	/** 依赖豁免名单 */
	readonly exempt = new Set<string>();
	/** 收敛时这些 id 有跳过理由 */
	readonly blocked = new Map<string, string[]>();
	/** 下一次 beforeEnable 是否取消 */
	cancelNext = false;
	/** 模块工厂: 缺省是一个只记轨迹的 init */
	moduleFactory: (e: ProbeEntity) => PluginModule<ProbeContext> = (e) => ({
		init: async () => { this.trace.push(`init:${e.id}`); },
	});
	/** 最近一次创建的上下文, 供"取消时是否释放"断言 */
	lastContext: ProbeContext | null = null;

	constructor() { super("探针"); }

	protected loggerSource(): Logger { return stubLogger; }
	protected registries(): Map<string, ProbeEntity>[] { return [this.regA, this.regB]; }
	protected lookupRegistries(): Map<string, ProbeEntity>[] { return [this.regB, this.regA]; }

	protected configFileFor(entity: ProbeEntity): string {
		return path.join(tmp, "values", `${entity.id}.json`);
	}

	protected createEntity(manifest: PluginManifest, index: number): ProbeEntity {
		this.trace.push(`create:${manifest.id}:${index}`);
		return new ProbeEntity(manifest);
	}

	protected createContext(entity: ProbeEntity): ProbeContext {
		this.trace.push(`context:${entity.id}`);
		this.lastContext = new ProbeContext();
		return this.lastContext;
	}

	protected async loadModule(entity: ProbeEntity): Promise<PluginModule<ProbeContext>> {
		this.trace.push(`module:${entity.id}`);
		return this.moduleFactory(entity);
	}

	protected beforeEnable(entity: ProbeEntity): boolean {
		this.trace.push(`hook:${entity.id}`);
		return this.cancelNext;
	}

	protected releaseExports(entity: ProbeEntity): void {
		this.trace.push(`release:${entity.id}`);
	}

	protected isDependencyExempt(id: string): boolean { return this.exempt.has(id); }

	protected acceptManifest(manifest: PluginManifest): boolean {
		return manifest.type !== "service";
	}

	protected preLoadIssues(id: string): string[] { return this.blocked.get(id) ?? []; }

	/* 暴露受保护成员供断言直接调用 */
	converge(wanted: string[]): Promise<string[]> { return this.convergeState(new Set(wanted)); }
	scanInto(dir: string, registry = this.regA, index = 0): Promise<void> { return this.scanDir(dir, registry, index); }
	cycles(): void { this.checkDependencyCycles(); }
	async setup(entity: ProbeEntity): Promise<void> { return this.setupConfig(entity); }
}

const host = new ProbeHost();
host.regA.set("a", new ProbeEntity(manifestOf("a")));
host.regB.set("b", new ProbeEntity(manifestOf("b")));

try {
	/* ---------- 1. 注册表与查找顺序 ---------- */
	console.log("\n[注册表]");
	check("allEntities 按 registries 顺序", host.allEntities().map(e => e.id).join(",") === "a,b");
	const shadow = new ProbeEntity(manifestOf("a"));
	host.regB.set("a", shadow);
	check("resolve 走 lookupRegistries(私有表优先)", host.resolve("a") === shadow);
	host.regB.delete("a");
	check("删除覆盖项后回落到第一张表", host.resolve("a") === host.regA.get("a"));
	host.regA.get("a")!.status = "enabled";
	check("enabledEntities 只含 enabled", host.enabledEntities().map(e => e.id).join(",") === "a");
	host.regA.get("a")!.status = "registered";

	/* ---------- 2. 依赖图 ---------- */
	console.log("\n[依赖图]");
	const dep = new ProbeEntity(manifestOf("dep"));
	const main = new ProbeEntity(manifestOf("main", { dep: "=0.0.0" }));
	const missing = new ProbeEntity(manifestOf("missing", { ghost: "=0.0.0" }));
	host.regA.set("dep", dep);
	host.regA.set("main", main);
	host.regA.set("missing", missing);
	check("缺失依赖预检拒绝加载", await rejects(() => host.load("missing"), "依赖未注册"));
	host.exempt.add("ghost");
	check("豁免的依赖不算缺失", await (async () => { await host.load("missing"); return true; })());
	host.exempt.delete("ghost");

	host.trace.length = 0;
	await host.load("main");
	check("依赖先于依赖者 init",
		host.trace.indexOf("init:dep") >= 0
		&& host.trace.indexOf("init:main") > host.trace.indexOf("init:dep"), host.trace.join(","));
	check("加载调用链: module → context → hook → init",
		host.trace.filter(l => l.startsWith("module:main")).length === 1
		&& host.trace.indexOf("context:main") < host.trace.indexOf("hook:main")
		&& host.trace.indexOf("hook:main") < host.trace.indexOf("init:main"), host.trace.join(","));

	const before = host.trace.filter(l => l === "init:main").length;
	await host.load("main");
	check("load 幂等: 重复调用不再 init", host.trace.filter(l => l === "init:main").length === before);

	const cycX = new ProbeEntity(manifestOf("cyc-x", { "cyc-y": "=0.0.0" }));
	const cycY = new ProbeEntity(manifestOf("cyc-y", { "cyc-x": "=0.0.0" }));
	host.regA.set("cyc-x", cycX);
	host.regA.set("cyc-y", cycY);
	check("依赖环预检拒绝加载", await rejects(() => host.load("cyc-x"), "依赖存在循环"));
	logs.length = 0;
	host.cycles();
	check("全图环检测会告警且不阻断", logs.some(l => l.includes("依赖循环")));

	/* ---------- 3. load 失败与取消 ---------- */
	console.log("\n[失败回滚]");
	const cancelled = new ProbeEntity(manifestOf("cancelled"));
	host.regA.set("cancelled", cancelled);
	host.cancelNext = true;
	check("Hook 取消时抛错", await rejects(() => host.load("cancelled"), "启用被 Hook 取消"));
	check("取消后状态回到 registered", cancelled.status === "registered");
	check("取消时上下文被释放且未挂到实体上",
		cancelled.context === null && (host.lastContext?.disposed ?? 0) === 1);
	host.cancelNext = false;

	const boom = new ProbeEntity(manifestOf("boom"));
	host.regA.set("boom", boom);
	host.moduleFactory = () => ({ init: async () => { throw new Error("init boom"); } });
	check("init 抛错时异常透传", await rejects(() => host.load("boom"), "init boom"));
	check("init 抛错后状态回滚", boom.status === "registered");
	host.moduleFactory = (e) => ({ init: async () => { host.trace.push(`init:${e.id}`); } });

	/* ---------- 4. 递归卸载 ---------- */
	console.log("\n[递归卸载]");
	host.trace.length = 0;
	await host.unload("dep");
	check("卸载依赖者先于被依赖者",
		host.trace.indexOf("release:main") < host.trace.indexOf("release:dep"), host.trace.join(","));
	check("递归卸载后都进入 disabled", dep.status === "disabled" && main.status === "disabled");
	const releaseCount = host.trace.filter(l => l === "release:dep").length;
	await host.unload("dep");
	check("unload 幂等", host.trace.filter(l => l === "release:dep").length === releaseCount);

	/* ---------- 5. convergeState ---------- */
	console.log("\n[状态收敛]");
	// 造出"一个要卸载(main 已启用但不在期望里)、一个要加载(dep 处于关态)"的局面
	main.status = "enabled";
	main.context = new ProbeContext();
	dep.status = "disabled";
	dep.module = null;
	dep.context = null;
	host.trace.length = 0;
	const failedList = await host.converge(["dep", "ghost-id"]);
	check("未注册项进入 failed", failedList.includes("ghost-id"), failedList.join(","));
	check("期望外的实体被卸载", main.status === "disabled");
	check("期望内的关态实体被加载", dep.status === "enabled");
	check("先卸载再加载",
		host.trace.findIndex(l => l === "release:main") >= 0
		&& host.trace.findIndex(l => l === "release:main") < host.trace.indexOf("init:dep"),
		host.trace.join(","));

	host.blocked.set("dep", ["stopped-svc"]);
	host.trace.length = 0;
	await host.unload("dep");
	host.trace.length = 0;
	const blockedFailed = await host.converge(["dep"]);
	check("跳过理由计入 failed", blockedFailed.includes("dep"));
	check("跳过时不调用 loadModule", !host.trace.some(l => l.startsWith("module:dep")), host.trace.join(","));
	check("跳过时记录告警", logs.some(l => l.includes("依赖已被停用")));
	host.blocked.clear();

	/* ---------- 6. 配置装配 ---------- */
	console.log("\n[配置装配]");
	const defineDir = path.join(tmp, "with-config");
	await fs.mkdir(defineDir, { recursive: true });
	await fs.writeFile(path.join(defineDir, "config.json"), JSON.stringify({ controls: [{ id: "title", type: "input", default: "hi" }] }));
	const configured = new ProbeEntity(manifestOf("configured", {}, { config: path.join(defineDir, "config.json") }));
	await host.setup(configured);
	check("setupConfig 装上 schema 与值管理器",
		configured.configSchema !== null && configured.config !== null);
	check("值文件路径来自 configFileFor 策略",
		configured.config?.file === path.join(tmp, "values", "configured.json"));

	/* ---------- 7. 派发 ---------- */
	console.log("\n[事件派发]");
	const ctx = new ProbeContext();
	dep.context = ctx;
	dep.status = "enabled";
	host.handleMessage({ text: "hi" });
	host.handlePlatformEvent({ raw: 1 }, {} as never);
	check("消息派发给已启用实体", ctx.messages.length === 1);
	check("平台事件派发给已启用实体", ctx.events === 1);
	dep.status = "disabled";

	/* ---------- 8. scanDir 对账 ---------- */
	console.log("\n[扫描对账]");
	const scanRoot = path.join(tmp, "scan");
	const writePlugin = async (id: string, m: Record<string, unknown>) => {
		const dir = path.join(scanRoot, id);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
			id, version: "0.0.0", main: "index.ts", ...m,
		}));
	};
	await writePlugin("p1", {});
	await writePlugin("p2", { type: "service" });
	const scanReg = new Map<string, ProbeEntity>();
	await host.scanInto(scanRoot, scanReg);
	check("acceptManifest 过滤掉的清单不进注册表",
		scanReg.has("p1") && !scanReg.has("p2"));
	check("createEntity 收到 registries 索引", host.trace.includes("create:p1:0"));

	const kept = scanReg.get("p1");
	host.trace.length = 0;
	await host.scanInto(scanRoot, scanReg);
	check("默认 shouldReplace: 清单未变不重建", scanReg.get("p1") === kept && !host.trace.includes("create:p1:0"));

	await fs.writeFile(path.join(scanRoot, "p1", "manifest.json"), JSON.stringify({
		id: "p1", version: "0.0.1", main: "index.ts", name: "changed",
	}));
	host.trace.length = 0;
	await host.scanInto(scanRoot, scanReg);
	check("清单变化时重建关态实例", scanReg.get("p1") !== kept && host.trace.includes("create:p1:0"));

	scanReg.get("p1")!.status = "enabled";
	await fs.writeFile(path.join(scanRoot, "p1", "manifest.json"), JSON.stringify({
		id: "p1", version: "0.0.2", main: "index.ts", name: "changed-again",
	}));
	const active = scanReg.get("p1");
	await host.scanInto(scanRoot, scanReg);
	check("活跃实例不被扫描替换", scanReg.get("p1") === active);
	active!.status = "registered";

	await fs.rm(path.join(scanRoot, "p1"), { recursive: true, force: true });
	await host.scanInto(scanRoot, scanReg);
	check("悬空条目被清理", !scanReg.has("p1"));
} finally {
	await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
