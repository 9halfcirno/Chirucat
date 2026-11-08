/**
 * WebUI 插件/服务配置端点自检
 *
 * 状态管理重构第 4 批把四个配置端点的"按需装配 + 404"薄壳收敛到
 * `_shared.requirePluginConfig`, 并把两个 view 的字段映射收敛到
 * `toManagedView`。这些端点原先**没有任何检查脚本覆盖**, 前端又钉住了
 * 返回结构, 所以这里用轻量 Core 替身直接调用 handler, 把形状钉住。
 *
 * 刻意保留的不对称也在断言里: 插件 payload 是 `{running, plugins:{global,bot}}`,
 * 服务 payload 是 `{plugins:[...]}`; 插件 hasConfig 看装配结果, 服务看清单声明;
 * set_service_state 严格校验布尔并回完整列表, set_plugin_state 宽松转换且
 * **只回 affected**(依赖连带的插件 id), 不扫描目录也不回传完整列表。
 * 末尾还静态检查前端确实消费了 affected 并同步卡片/开关的状态闭包。
 *
 * 用法:
 *   npx tsx scripts/check-webui-config-api.ts
 *
 * 纯内存, 不创建文件; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { ConfigManager } from "../src/config/manager";
import type { ConfigRoot } from "../src/config/types";
import { root } from "../src/utils/root";
import type { Core } from "../src/core";
import type { Bot } from "../src/bot/bot";
import type { Plugin } from "../src/plugin/plugin";
import type { Service } from "../src/plugin/services/service";
import type { ServiceHost } from "../src/plugin/services/host";
import type { PluginManifest, PluginStatus } from "../src/plugin/types";
import type { WebUIAPI } from "../src/webui/server/types";
import type { APIError } from "../src/webui/server/api/_shared";

import getPluginConfig from "../src/webui/server/api/get_plugin_config";
import getServiceConfig from "../src/webui/server/api/get_service_config";
import updatePluginConfig from "../src/webui/server/api/update_plugin_config";
import updateServiceConfig from "../src/webui/server/api/update_service_config";
import getPluginList from "../src/webui/server/api/get_plugin_list";
import getServiceList from "../src/webui/server/api/get_service_list";
import refreshPlugins from "../src/webui/server/api/refresh_plugins";
import refreshServices from "../src/webui/server/api/refresh_services";
import setPluginState from "../src/webui/server/api/set_plugin_state";
import setServiceState from "../src/webui/server/api/set_service_state";

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

const schema = {
	controls: [{ type: "input", id: "name", label: "名称", default: "chiru" }],
} as ConfigRoot;

type EntityShape = {
	id: string;
	manifest: PluginManifest;
	status: PluginStatus;
	config: ConfigManager | null;
	configSchema: ConfigRoot | null;
	type: string;
	scope: "global" | "bot";
};

function makeEntity(id: string, options: {
	hasConfig?: boolean; declared?: boolean; status?: PluginStatus; type?: string;
} = {}): EntityShape {
	const manifest = {
		id, version: "1.0.0", main: "index.ts", path: ".",
		name: `Name-${id}`, author: "tester", description: "desc",
		...(options.declared ? { config: "config.json" } : {}),
	} as PluginManifest;
	return {
		id,
		manifest,
		status: options.status ?? "enabled",
		type: options.type ?? "normal",
		scope: "global",
		config: options.hasConfig ? new ConfigManager(schema) : null,
		configSchema: options.hasConfig ? schema : null,
	};
}

const globalPlugins = new Map<string, EntityShape>();
const botPlugins = new Map<string, EntityShape>();
const serviceRegistry = new Map<string, EntityShape>();

let setupCalls = 0;
let refreshCalls = 0;
let toggled: { id: string; state: boolean } | null = null;
/** 模拟 PluginManager 的依赖连带: 这些插件的运行态会随本次启停一起变 */
let cascade: string[] | null = null;

const assemble = async (entity: EntityShape): Promise<void> => {
	setupCalls++;
	entity.config = new ConfigManager(schema);
	entity.configSchema = schema;
};

const allPluginEntities = () => [...globalPlugins.values(), ...botPlugins.values()];

const bot = {
	id: "b1",
	running: true,
	plugin: {
		globalPlugins,
		botPlugins,
		resolve: (id: string) => botPlugins.get(id) ?? globalPlugins.get(id),
		allEntities: allPluginEntities,
		setupConfig: assemble,
	},
	refreshPlugins: async () => { refreshCalls++; },
	setPluginEnabled: async (id: string, state: boolean) => {
		toggled = { id, state };
		const status: PluginStatus = state ? "enabled" : "disabled";
		// 真实宿主只把"本次真的变了"的连带插件计入 affected: 本来就关着的依赖者
		// 不该出现, 目标自身由 enabled 字段表达
		const affected = allPluginEntities()
			.filter((e) => e.id !== id && cascade?.includes(e.id) && e.status !== status)
			.map((e) => e.id);
		for (const entity of allPluginEntities()) {
			if (entity.id === id || affected.includes(entity.id)) entity.status = status;
		}
		return { id, enabled: status === "enabled", affected };
	},
} as unknown as Bot;

const services = {
	registry: serviceRegistry,
	resolve: (id: string) => serviceRegistry.get(id),
	setupConfig: assemble,
	scan: async () => {},
	syncState: async () => ["failed-id"],
	setEnabled: async (id: string, enabled: boolean) => ({ id, enabled, affected: [] }),
} as unknown as ServiceHost;

const core = {
	bot: { bots: new Map([["b1", bot]]) },
	services,
} as unknown as Core;

type CallResult =
	| { ok: true; value: Record<string, any> }
	| { ok: false; error: APIError };

async function call(api: WebUIAPI, body: Record<string, unknown> = {}): Promise<CallResult> {
	try {
		const value = await api.handler!({ body } as never, core);
		return { ok: true, value: value as Record<string, any> };
	} catch (e) {
		return { ok: false, error: e as APIError };
	}
}

const body = (id: string, extra: Record<string, unknown> = {}) => ({ bot: "b1", id, ...extra });

try {
	/* ---------- 1. 配置读取 ---------- */
	console.log("\n[配置读取]");
	const p1 = makeEntity("p1", { hasConfig: true, declared: true });
	globalPlugins.set("p1", p1);
	const r1 = await call(getPluginConfig, body("p1"));
	check("get_plugin_config 返回 define + config",
		r1.ok && r1.value.success === true && r1.value.define === schema
		&& r1.value.config?.name === "chiru", JSON.stringify(r1));
	check("get_plugin_config 不含多余字段",
		r1.ok && Object.keys(r1.value).sort().join(",") === "config,define,success");

	const p2 = makeEntity("p2", { declared: true, status: "disabled" });
	globalPlugins.set("p2", p2);
	setupCalls = 0;
	const r2 = await call(getPluginConfig, body("p2"));
	check("插件配置未装配时按需重新装配",
		r2.ok && setupCalls === 1 && r2.value.config?.name === "chiru", JSON.stringify(r2));

	const r3 = await call(getPluginConfig, body("ghost"));
	check("插件不存在抛 404", !r3.ok && r3.error.code === 404 && r3.error.err.includes("不存在"));

	globalPlugins.clear();
	botPlugins.clear();
	const r4 = await call(getPluginConfig, body("ghost"));
	check("未扫描 Bot 时给出专门的提示",
		!r4.ok && r4.error.code === 404 && r4.error.err.includes("尚未扫描插件"));
	globalPlugins.set("p1", p1);
	globalPlugins.set("p2", p2);

	const s1 = makeEntity("s1", { hasConfig: true, declared: true, type: "service" });
	serviceRegistry.set("s1", s1);
	const r5 = await call(getServiceConfig, { id: "s1" });
	check("get_service_config 与插件版同构",
		r5.ok && r5.value.success === true && r5.value.define === schema
		&& r5.value.config?.name === "chiru", JSON.stringify(r5));

	const s2 = makeEntity("s2", { declared: true, type: "service", status: "disabled" });
	serviceRegistry.set("s2", s2);
	setupCalls = 0;
	const r6 = await call(getServiceConfig, { id: "s2" });
	check("服务配置未装配时按需重新装配",
		r6.ok && setupCalls === 1 && r6.value.config?.name === "chiru", JSON.stringify(r6));

	const r7 = await call(getServiceConfig, { id: "ghost" });
	check("服务插件不存在抛 404", !r7.ok && r7.error.code === 404 && r7.error.err.includes("不存在"));

	/* ---------- 2. 配置更新 ---------- */
	console.log("\n[配置更新]");
	const p3 = makeEntity("p3", { declared: true });
	globalPlugins.set("p3", p3);
	setupCalls = 0;
	const r8 = await call(updatePluginConfig, body("p3", { config: { name: "x" } }));
	check("update_plugin_config 不重装配, 缺配置直接 404",
		!r8.ok && r8.error.code === 404 && setupCalls === 0
		&& r8.error.err.includes("没有可用的配置"), JSON.stringify(r8));

	const r9 = await call(updatePluginConfig, body("p1", { config: { name: "changed" } }));
	check("update_plugin_config 保存并回传规范化值",
		r9.ok && r9.value.success === true && r9.value.config?.name === "changed", JSON.stringify(r9));

	const r10 = await call(updatePluginConfig, body("p1", { config: "not-an-object" }));
	check("校验失败抛 400 并带字段级 details",
		!r10.ok && r10.error.code === 400 && Array.isArray(r10.error.details), JSON.stringify(r10));

	const s3 = makeEntity("s3", { declared: true, type: "service" });
	serviceRegistry.set("s3", s3);
	setupCalls = 0;
	const r11 = await call(updateServiceConfig, { id: "s3", config: { name: "svc" } });
	check("update_service_config 会重装配后保存",
		r11.ok && setupCalls === 1 && r11.value.config?.name === "svc", JSON.stringify(r11));

	/* ---------- 3. 列表与视图 ---------- */
	console.log("\n[列表与视图]");
	const r12 = await call(getPluginList, { bot: "b1" });
	check("插件 payload 是分组对象且带 running",
		r12.ok && r12.value.running === true
		&& Array.isArray(r12.value.plugins?.global) && Array.isArray(r12.value.plugins?.bot),
		JSON.stringify(r12));

	const r13 = await call(getServiceList);
	check("服务 payload 是数组(与插件版刻意不同)",
		r13.ok && Array.isArray(r13.value.plugins), JSON.stringify(r13));

	const pv = r12.ok ? r12.value.plugins.global[0] : undefined;
	check("PluginView 字段齐全",
		pv && pv.id === "p1" && pv.name === "Name-p1" && pv.version === "1.0.0"
		&& pv.author === "tester" && pv.description === "desc"
		&& pv.type === "normal" && pv.scope === "global" && pv.status === "enabled"
		&& pv.hasConfig === true, JSON.stringify(pv));

	const sv = r13.ok ? r13.value.plugins.find((s: any) => s.id === "s1") : undefined;
	check("ServiceView 固定 type、无 scope",
		sv && sv.type === "service" && !("scope" in sv) && sv.status === "enabled", JSON.stringify(sv));

	const p4 = makeEntity("p4", { declared: true, status: "registered" });
	globalPlugins.set("p4", p4);
	const r14 = await call(getPluginList, { bot: "b1" });
	const p4v = r14.ok ? r14.value.plugins.global.find((p: any) => p.id === "p4") : undefined;
	check("hasConfig 口径: 插件看装配结果", p4v && p4v.hasConfig === false);
	check("registered 收敛成 disabled", p4v && p4v.status === "disabled");

	const s4 = makeEntity("s4", { declared: true, type: "service", status: "disabled" });
	serviceRegistry.set("s4", s4);
	const r15 = await call(getServiceList);
	const s4v = r15.ok ? r15.value.plugins.find((s: any) => s.id === "s4") : undefined;
	check("hasConfig 口径: 服务按清单声明(停用后仍可点开配置)",
		s4v && s4v.hasConfig === true && s4v.status === "disabled", JSON.stringify(s4v));

	/* ---------- 4. 刷新与状态切换 ---------- */
	console.log("\n[刷新与状态切换]");
	refreshCalls = 0;
	const r16 = await call(refreshPlugins, { bot: "b1" });
	check("refresh_plugins 扫描后回传同形状列表",
		r16.ok && r16.value.success === true && refreshCalls === 1
		&& Array.isArray(r16.value.plugins?.global), JSON.stringify(r16));

	const r17 = await call(refreshServices);
	check("refresh_services 额外回传 failed",
		r17.ok && r17.value.success === true && Array.isArray(r17.value.failed)
		&& r17.value.failed.includes("failed-id"), JSON.stringify(r17));

	const r18 = await call(setServiceState, { id: "s1", state: "true" });
	check("set_service_state 严格校验布尔", !r18.ok && r18.error.code === 400);

	const r19 = await call(setServiceState, { id: "s1", state: true });
	check("set_service_state 回传 affected 与完整列表",
		r19.ok && r19.value.success === true && Array.isArray(r19.value.affected)
		&& Array.isArray(r19.value.plugins), JSON.stringify(r19));

	cascade = null;
	toggled = null;
	const r20 = await call(setPluginState, body("p1", { state: 1 }));
	check("set_plugin_state 宽松转换, 无连带时 affected 为空",
		r20.ok && r20.value.success === true && r20.value.state === true
		&& toggled?.state === true && Array.isArray(r20.value.affected)
		&& r20.value.affected.length === 0 && !("plugins" in r20.value), JSON.stringify(r20));

	// 停用 p1 连带停用 p2 / p3; p3 本来就是关态, 不该被计入
	p2.status = "enabled";
	p3.status = "disabled";
	cascade = ["p2", "p3"];
	const r20b = await call(setPluginState, body("p1", { state: false }));
	check("停用时的 affected 只含真正变化的关联插件",
		r20b.ok && r20b.value.state === false
		&& JSON.stringify(r20b.value.affected) === JSON.stringify(["p2"]), JSON.stringify(r20b));
	check("affected 不含目标自身, 也不回传完整列表",
		r20b.ok && !r20b.value.affected.includes("p1") && !("plugins" in r20b.value));

	// 反向: 启用时连带拉起依赖
	cascade = ["p2"];
	const r20c = await call(setPluginState, body("p1", { state: true }));
	check("启用时的 affected 反映被连带拉起的依赖",
		r20c.ok && r20c.value.state === true
		&& r20c.value.affected.includes("p2") && !r20c.value.affected.includes("p3"),
		JSON.stringify(r20c));
	cascade = null;

	const r21 = await call(setPluginState, body("ghost", { state: true }));
	check("set_plugin_state 目标不存在抛 404", !r21.ok && r21.error.code === 404);

	/* ---------- 5. 前端联动接线(静态契约) ---------- */
	console.log("\n[前端联动接线]");
	const jsRoot = path.join(root, "src", "webui", "public", "js");
	const cardSrc = await fs.readFile(path.join(jsRoot, "spa", "components", "plugin-card.js"), "utf-8");
	const switchSrc = await fs.readFile(path.join(jsRoot, "spa", "components", "dot-switch.js"), "utf-8");
	const pluginsSrc = await fs.readFile(path.join(jsRoot, "pages", "bots", "bot-pages", "plugins.js"), "utf-8");
	check("卡片提供按 id 定位的锚与状态同步入口",
		cardSrc.includes("dataset.pluginId") && cardSrc.includes("setPluginStatus"));
	check("dot-switch 提供 setState 同步内部状态闭包", switchSrc.includes("swh.setState"));
	check("插件页消费 affected 并逐个对齐卡片",
		pluginsSrc.includes("data.affected") && pluginsSrc.includes("setPluginStatus"));
	check("失败时用只读列表对齐界面(不重新扫描目录)",
		pluginsSrc.includes("/api/get_plugin_list"));
} finally {
	// 纯内存, 无需清理
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
