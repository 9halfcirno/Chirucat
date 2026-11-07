/**
 * 插件宿主与服务插件宿主共通的注册表 / 依赖图 / 启停骨架
 *
 * `PluginManager`(每个 Bot 一份, 双注册表) 与 `ServiceHost`(Core 上的全局单例,
 * 单注册表) 的发现、依赖预检、按依赖顺序加载、递归卸载、状态收敛、配置装配
 * 是同一套流程。共通部分固定在这个基类里; 差异全部由**显式覆写的策略方法**
 * 表达, 不用布尔开关在基类内部切分支:
 *
 * | 策略方法 | 插件宿主 | 服务宿主 |
 * | --- | --- | --- |
 * | `registries` / `lookupRegistries` | 全局+Bot私有双表, 查找私有优先 | 单表 |
 * | `configFileFor` | `<Bot>/configs/plugins/<id>.json` | `configs/services/<id>.json` |
 * | `createEntity` / `createContext` | `Plugin` + `PluginContextFactory` | `Service` + `ServiceContext` |
 * | `loadModule` | 受限加载器 | 允许内置模块 |
 * | `beforeEnable` | `before.plugin.enable` | `before.service.enable` |
 * | `releaseExports` | 两张导出表 | 一张 |
 * | `isDependencyExempt` | 依赖可指向全局服务插件 | 无豁免 |
 * | `shouldReplace` | 清单变化才重建 | 每次扫描都重建关态实例 |
 * | `preLoadIssues` | 无 | 依赖被显式停用时跳过 |
 * | `acceptManifest` / `onReadError` | 跳过 service 类型 | 只收 service 类型 |
 *
 * **刻意留在子类的编排层**: 服务宿的 `state` / `serialize` / `released` 栅栏 /
 * `setEnabled` 依赖连带 / `dispose`, 以及插件宿的 `scan` 双目录 / `handleAction`。
 * 尤其"期望名单在哪里求解": 插件宿在调用点读白名单, 服务宿必须在串行队列
 * **内部**读黑名单(排队期间用户可能刚改过状态) —— 基类只提供 `convergeState`,
 * 由两个子类各自保留 `syncState` 外壳, 不统一时机。
 */
import path from "node:path";
import { ConfigManager } from "../config/manager";
import { readConfigDefine } from "../config/define";
import type { ConfigRoot } from "../config/types";
import { deepEqual } from "../config/store";
import type { Message } from "../entity/message";
import { StateError } from "../errors/state-error";
import type { BotEventMeta } from "../protocols/events";
import { dfs } from "../utils/dfs";
import type Logger from "../utils/logger";
import { readManifests } from "./manifest";
import type { DisposableContext } from "./managed-entity";
import type { PluginManifest, PluginModule, PluginStatus } from "./types";

/** 宿主对运行上下文的要求: 可释放、可派发消息与平台原生事件 */
export interface HostContextLike extends DisposableContext {
	handleMessage(msg: Message): void;
	handlePlatformEvent(event: Record<string, any>, meta: BotEventMeta): void;
}

/** 宿主对实体的要求: 共通字段与状态机入口, 不含任何 Bot/Core 耦合 */
export interface ManagedEntityLike<C> {
	readonly id: string;
	manifest: PluginManifest;
	status: PluginStatus;
	context: C | null;
	module: PluginModule<C> | null;
	configSchema: ConfigRoot | null;
	config: ConfigManager | null;
	enable(ctx?: C): Promise<void>;
	disable(destroy?: boolean): Promise<void>;
}

/** 活跃态: 实例持有异步流程引用, 扫描时既不替换也不清理 */
const ACTIVE: PluginStatus[] = ["enabled", "loading", "unloading"];

export abstract class ManagedHostBase<
	E extends ManagedEntityLike<C>,
	C extends HostContextLike,
> {
	/** 日志与错误文案里的主体名: `插件` / `服务插件` */
	protected readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	/* ---------- 子类必须给出的差异(策略方法) ---------- */

	/** 日志器来源; 构造期不读取, 避免子类字段尚未初始化 */
	protected abstract loggerSource(): Logger;
	protected get hostLog(): Logger { return this.loggerSource(); }

	/** 全部注册表, 按迭代顺序(插件宿主: 全局在前; 服务宿主: 单表) */
	protected abstract registries(): Map<string, E>[];

	/** 按 id 查找时的表顺序; 缺省与迭代顺序一致 */
	protected lookupRegistries(): Map<string, E>[] { return this.registries(); }

	/** 配置值文件路径 */
	protected abstract configFileFor(entity: E): string;

	/** 由清单创建实体; index 是它在 registries 里的位置(普通插件据此定 scope) */
	protected abstract createEntity(manifest: PluginManifest, index: number): E;

	/** 创建运行上下文 */
	protected abstract createContext(entity: E): C;

	/** 加载模块(加载器与受限策略各不同) */
	protected abstract loadModule(entity: E): Promise<PluginModule<C>>;

	/** 启用前 Hook, 返回 true 表示取消 */
	protected abstract beforeEnable(entity: E): boolean;

	/** 卸载后兜底释放该实体的导出 */
	protected abstract releaseExports(entity: E): void;

	/** 依赖 id 是否算"已满足"(插件宿允许依赖全局服务插件) */
	protected isDependencyExempt(_id: string): boolean { return false; }

	/** 关态实例是否要用新清单重建 */
	protected shouldReplace(existing: E, manifest: PluginManifest): boolean {
		return !deepEqual(existing.manifest, manifest);
	}

	/** 清单是否属于本宿主 */
	protected acceptManifest(_manifest: PluginManifest, _id: string): boolean { return true; }

	/** 单个清单读取失败时的上报方式 */
	protected onReadError(error: unknown, _pluginDir: string): void { this.hostLog.error(error); }

	/** 收敛时该 id 是否要跳过(返回跳过理由, 空数组表示放行) */
	protected preLoadIssues(_id: string): string[] | Promise<string[]> { return []; }

	/* ---------- 注册表与依赖图 ---------- */

	/** 全部实体, 按 registries 顺序 */
	allEntities(): E[] {
		return this.registries().flatMap((r) => [...r.values()]);
	}

	/** 按 id 解析实体 */
	resolve(id: string): E | undefined {
		for (const registry of this.lookupRegistries()) {
			const found = registry.get(id);
			if (found) return found;
		}
		return undefined;
	}

	/** 已启用实体, 按注册顺序 */
	enabledEntities(): E[] {
		return this.allEntities().filter((e) => e.status === "enabled");
	}

	/** 已注册的依赖实体(未注册的只告警, 缺失拦截由 load 预检负责) */
	protected getDependencies(entity: E): E[] {
		const deps: E[] = [];
		for (const depId of Object.keys(entity.manifest.dependencies ?? {})) {
			const dep = this.resolve(depId);
			if (!dep) {
				if (this.isDependencyExempt(depId)) continue;
				this.hostLog.warn(`${this.label} ${entity.id} 的依赖 ${depId} 未注册`);
				continue;
			}
			deps.push(dep);
		}
		return deps;
	}

	/** manifest 声明但未注册的依赖 id */
	protected getMissingDependencies(entity: E): string[] {
		const missing: string[] = [];
		for (const depId of Object.keys(entity.manifest.dependencies ?? {})) {
			if (this.resolve(depId) || this.isDependencyExempt(depId)) continue;
			missing.push(depId);
		}
		return missing;
	}

	/** 依赖指定实体的实体(跨全部注册表) */
	protected getDependents(id: string): E[] {
		return this.allEntities().filter((e) => e.manifest.dependencies?.[id]);
	}

	/** 全图循环检测: 以每个实体为根跑一次 dfs, 发现环只告警不阻断 */
	protected checkDependencyCycles(): void {
		const reported = new Set<string>();
		for (const entity of this.allEntities()) {
			if (reported.has(entity.id)) continue;
			const cycle = dfs(entity, (e) => e.id, (e) => this.getDependencies(e));
			if (!cycle) continue;
			cycle.forEach((e) => reported.add(e.id));
			this.hostLog.warn(`检测到${this.label}依赖循环: ${cycle.map((e) => e.id).join(" -> ")}`);
		}
	}

	/* ---------- 配置装配 ---------- */

	/**
	 * 装配配置: 定义来自插件自带的 manifest.config, 值文件路径由策略给出。
	 * 未声明 config 的实体保持 config = null; 读取失败只记日志, 不阻断注册。
	 */
	async setupConfig(entity: E): Promise<void> {
		const define = entity.manifest.config;
		if (!define) return;

		const file = path.resolve(entity.manifest.path, define);
		try {
			const schema = await readConfigDefine(file);
			const config = new ConfigManager(schema, this.configFileFor(entity));
			await config.load();

			const target: ManagedEntityLike<C> = entity;
			target.configSchema = schema;
			target.config = config;
		} catch (e) {
			this.hostLog.error(`装配${this.label} ${entity.id} 的配置失败: ${e instanceof Error ? e.message : e}`);
		}
	}

	/* ---------- 扫描对账 ---------- */

	/** 扫描一个目录并把清单对账进指定注册表 */
	protected async scanDir(dir: string, registry: Map<string, E>, index: number): Promise<void> {
		const collected = await readManifests(dir, (e, pluginDir) => this.onReadError(e, pluginDir));

		for (const [id, manifest] of [...collected]) {
			if (!this.acceptManifest(manifest, id)) collected.delete(id);
		}

		for (const [id, manifest] of collected) {
			const existing = registry.get(id);
			if (existing && (ACTIVE.includes(existing.status) || !this.shouldReplace(existing, manifest))) continue;
			// 实例即将被丢弃, 先释放其运行时资源(含对外导出)
			await existing?.context?.dispose();
			const entity = this.createEntity(manifest, index);
			await this.setupConfig(entity);
			registry.set(id, entity);
		}

		// 清理悬空条目: 目录中已消失且不在活跃态的实体
		for (const [id, entity] of [...registry]) {
			if (!collected.has(id) && !ACTIVE.includes(entity.status)) {
				await entity.context?.dispose();
				registry.delete(id);
			}
		}
	}

	/* ---------- 启停 ---------- */

	/**
	 * 启动指定实体: 依赖环/缺失预检 → 按依赖顺序递归加载 → 构建模块与上下文 →
	 * 启用前 Hook → enable。失败时回到加载前的关态, 不引入第三种状态。
	 */
	async load(id: string): Promise<void> {
		const entity = this.resolve(id);
		if (!entity) throw new Error(`${this.label} ${id} 未被索引`)
		if (entity.status === "enabled") return; // 幂等
		if (entity.status === "loading" || entity.status === "unloading") {
			throw new StateError(`${this.label} ${id} 正在切换状态, 请稍后再试`)
		}

		const cycle = dfs(entity, (e) => e.id, (e) => this.getDependencies(e));
		if (cycle) throw new StateError(`${this.label}依赖存在循环, 拒绝加载: ${cycle.map((e) => e.id).join(" -> ")}`);

		const missing = this.getMissingDependencies(entity);
		if (missing.length) {
			throw new StateError(`${this.label} ${id} 的依赖未注册: ${missing.join(", ")}`);
		}

		for (const dep of this.getDependencies(entity)) {
			await this.load(dep.id); // 多态: 服务宿的 released 检查在子类重写里
		}

		// 前置 loading: 覆盖整个加载流程(含模块构建), 防止扫描清理悬空条目时误删
		const target: ManagedEntityLike<C> = entity;
		const before = target.status;
		target.status = "loading";
		try {
			if (!target.module) {
				await this.setupConfig(entity);
				target.module = await this.loadModule(entity);
			}

			const context = this.createContext(entity);
			if (this.beforeEnable(entity)) {
				await context.dispose();
				throw new StateError(`${this.label} ${entity.id} 启用被 Hook 取消`);
			}

			try {
				await target.enable(context);
			} catch (e) {
				// enable 可能在其内部释放之前就报错, 这里兜底(dispose 幂等)
				await context.dispose();
				throw e;
			}

			this.hostLog.log(`成功载入${this.label}: ${entity.manifest.name || "???"}(${entity.id})`);
		} catch (e) {
			target.status = before;
			throw e;
		}
	}

	/** 卸载指定实体: 释放运行态, 保留注册表条目 */
	async unload(...ids: string[]): Promise<void> {
		for (const id of ids) {
			await this.unloadTree(id, []);
		}
	}

	/** 递归卸载: 先卸载依赖该实体的实体, 再卸载自身 */
	protected async unloadTree(id: string, stack: string[]): Promise<void> {
		if (stack.includes(id)) return; // 依赖环防御, 防止无限递归

		for (const dependent of this.getDependents(id)) {
			await this.unloadTree(dependent.id, [...stack, id]);
		}

		const entity = this.resolve(id);
		if (!entity || entity.status === "disabled" || entity.status === "registered") return; // 幂等
		await entity.disable(true);
		// 兜底: 导出正常已由 context.dispose() 释放, 这里覆盖上下文缺失等异常情况
		this.releaseExports(entity);
		this.hostLog.log(`已卸载${this.label}: ${entity.id}`);
	}

	/**
	 * 把运行态收敛到一份期望名单: 先卸后装, 逐项容错并汇总 failed[]。
	 *
	 * 期望名单**由调用方在进入本方法前算好**: 插件宿在调用点读白名单, 服务宿
	 * 在串行队列内部读黑名单, 两者时机不能统一(见文件头注释)。
	 */
	protected async convergeState(wanted: Set<string>): Promise<string[]> {
		const failed: string[] = [];

		for (const entity of [...this.enabledEntities()]) {
			if (!wanted.has(entity.id)) await this.unload(entity.id);
		}

		for (const id of wanted) {
			if (!this.resolve(id)) {
				this.hostLog.warn(`期望启用但未注册的${this.label}: ${id}`);
				failed.push(id);
				continue;
			}

			const issues = await this.preLoadIssues(id);
			if (issues.length) {
				this.hostLog.warn(`${this.label} ${id} 的依赖已被停用, 跳过加载: ${issues.join(", ")}`);
				failed.push(id);
				continue;
			}

			try {
				await this.load(id);
			} catch (e) {
				// 单个实体加载失败不阻断状态收敛, 记录后继续
				this.hostLog.error(`${this.label} ${id} 加载失败: ${e instanceof Error ? e.message : e}`);
				failed.push(id);
			}
		}

		return failed;
	}

	/* ---------- 派发 ---------- */

	/** 将消息派发给所有已启用实体(按注册顺序) */
	handleMessage(msg: Message): void {
		for (const entity of this.enabledEntities()) {
			entity.context?.handleMessage(msg);
		}
	}

	/** 将平台原生事件派发给所有已启用实体(逃生舱通路) */
	handlePlatformEvent(event: Record<string, any>, meta: BotEventMeta): void {
		for (const entity of this.enabledEntities()) {
			entity.context?.handlePlatformEvent(event, meta);
		}
	}
}
