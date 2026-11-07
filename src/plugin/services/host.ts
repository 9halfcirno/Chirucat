import path from "path";
import type { Bot } from "../../bot/bot";
import { CommandManager } from "../../command/manager";
import { ConfigManager } from "../../config/manager";
import type { Core } from "../../core";
import type { Message } from "../../entity/message";
import { StateError } from "../../errors/state-error";
import type { BotEvents, BotEventMeta } from "../../protocols/events";
import { dirCheck } from "../../utils/dir-check";
import Logger from "../../utils/logger";
import { ManagedHostBase } from "../managed-host";
import { PluginExports } from "../exports";
import { PluginLoader } from "../loader";
import type { PluginManifest, PluginStatus } from "../types";
import { Service, type ServiceModule } from "./service";
import { ServiceContext } from "./context";
import { ServiceStateManager } from "./state";

/**
 * 服务插件启停的结果
 */
export type ServiceToggleResult = {
	/** 目标服务插件 id */
	id: string;
	/** 目标服务收敛后的运行态 */
	enabled: boolean;
	/** 被连带变更的服务 id: 停用时是随之卸载的依赖者, 启用时是随之加载的依赖 */
	affected: string[];
};

/**
 * 服务插件宿主
 *
 * 注册表 / 依赖图 / 启停 / 收敛 / 配置装配由 `ManagedHostBase` 承担, 这里给出
 * 全局单例的差异策略(单表、ServiceContext、可信加载器、黑名单期望态),
 * 并保留本宿主独有的编排层: 持久化期望态、启停串行队列、依赖连带、释放流程。
 *
 * 生命周期由 Core 管理: init 时先于 Bot 扫描并加载(供 Bot 插件 require),
 * close 时后于 Bot 卸载(基础设施最后倒)。
 */
export class ServiceHost extends ManagedHostBase<Service, ServiceContext> {
	readonly logger = new Logger("ServiceHost");

	/** 服务插件专用加载器: services/ 属于框架级可信代码, 不限制内置模块 */
	loader = new PluginLoader({ allowRestrictedBuiltins: true });

	/** 服务插件注册表: id -> Service */
	registry = new Map<string, Service>();

	/** 服务插件的导出表, 对全部 Bot 的插件可见(见 PluginContext.require) */
	readonly exports = new PluginExports();

	/** 服务插件注册的全局指令表, 由各 Bot 的消息处理转发匹配 */
	readonly command = new CommandManager({});

	/**
	 * 服务插件的持久化期望态(哪些服务被显式停用)
	 *
	 * 可在装载前用 setStateFile 指到别处(测试/嵌入式注入), 因此不是 readonly。
	 */
	state: ServiceStateManager;

	/** 期望态是否已装载: 装载后不允许再换状态文件 */
	private stateLoaded = false;

	/** 取消状态文件变更监听 */
	private unwatchState: (() => void) | null = null;

	/** 启停串行化: 外部改动与 WebUI 操作不会交错启停 */
	private toggling: Promise<void> = Promise.resolve();

	/** 已进入释放流程: 队列里剩下的启停/收敛不再执行 */
	private released = false;

	/** 释放中的那次调用: 并发/重复 dispose 等的是同一次释放 */
	private disposing: Promise<void> | null = null;

	constructor(
		private readonly core: Core,
		stateFile: string = ConfigManager.fileForServiceState(),
	) {
		super("服务插件");
		this.state = new ServiceStateManager(stateFile);
	}

	/* ---------- 差异策略 ---------- */

	protected loggerSource(): Logger { return this.logger; }

	protected registries(): Map<string, Service>[] { return [this.registry]; }

	protected configFileFor(service: Service): string {
		return ConfigManager.fileForService(service.id);
	}

	protected createEntity(manifest: PluginManifest): Service {
		return new Service({ manifest, core: this.core });
	}

	protected createContext(service: Service): ServiceContext {
		return new ServiceContext(service, this.exports, this.command);
	}

	protected async loadModule(service: Service): Promise<ServiceModule> {
		const loaded = await this.loader.load<ServiceModule>(path.join(service.manifest.path, service.manifest.main));
		if (!loaded?.default) throw new Error(`服务插件 ${service.id} 没有默认导出`)
		return loaded.default;
	}

	protected beforeEnable(service: Service): boolean {
		// Hook 埋点: 服务启用之前, 可被已启用的服务插件取消
		// (与普通插件的 before.plugin.enable 同位置、同取消语义)
		return this.core.hooks.dispatch("before.service.enable", service);
	}

	protected releaseExports(service: Service): void {
		this.exports.releaseExports(service.id);
	}

	/** 关态服务每次扫描都重建, 不像插件宿那样要求清单发生变化 */
	protected shouldReplace(): boolean { return true; }

	protected acceptManifest(manifest: PluginManifest, id: string): boolean {
		if (manifest.type === "service") return true;
		this.logger.warn(`services/ 中跳过非 service 类型插件: ${id} (type=${manifest.type ?? "normal"})`);
		return false;
	}

	protected onReadError(error: unknown, pluginDir: string): void {
		this.logger.error(`读取服务插件清单失败: ${pluginDir}`, error);
	}

	/** 依赖闭包里有显式停用的服务时, 收敛阶段跳过该服务且不写盘 */
	protected preLoadIssues(id: string): string[] {
		return this.stoppedDependencies(id);
	}

	/* ---------- 状态文件与生命周期 ---------- */

	/** 状态文件路径 */
	get stateFile(): string {
		return this.state.file;
	}

	/**
	 * 覆盖状态文件路径(测试/嵌入式注入用)
	 *
	 * 只在期望态尚未装载时有效 —— 已经读过盘再换文件, 内存态与磁盘就会脱节。
	 */
	setStateFile(file: string) {
		if (this.stateLoaded) throw new StateError("服务插件状态已装载, 不能再更换状态文件");
		this.state = new ServiceStateManager(file);
	}

	/**
	 * 载入持久化状态并开始监听其变化
	 *
	 * 由 Core 在扫描前调用: 先知道哪些服务被停用, 才能算出期望态。开始监听后,
	 * 外部(含手工编辑)改动状态文件会自动收敛运行态, 与 Bot.initState 同语义。
	 */
	async initState(): Promise<void> {
		await this.state.load();
		this.stateLoaded = true;

		// 状态文件所在目录可能还不存在(没有任何服务插件写过配置时): 先建出来,
		// 否则 startWatching 会因为目录缺失而降级成"不响应外部改动"。
		// 建不出来(只读挂载等)也只降级: 监视会失败, 但读写本身仍能工作。
		try {
			await dirCheck(path.dirname(this.state.file));
		} catch (e) {
			this.logger.warn(`创建服务插件状态目录失败: ${e instanceof Error ? e.message : e}`);
		}

		this.unwatchState = this.state.watch(() => {
			// 监听回调不等待收敛, 失败只记录: 外部改动引发的收敛不该打断任何主流程
			void this.syncState().catch((e) => {
				this.logger.error("应用服务插件状态文件变更失败", e);
			});
		});

		this.state.startWatching();
	}

	/* ---------- 本宿主独有的入口 ---------- */

	/**
	 * 扫描服务插件目录, 创建 Service 实例(不加载模块)。
	 * 扫描排进启停队列: WebUI 的"刷新"不能与一次启停交错。
	 */
	async scan(dir: string = "services"): Promise<void> {
		return this.serialize(async () => {
			await this.scanDir(dir, this.registry, 0);
			this.checkDependencyCycles();
		});
	}

	/** 已启用的服务插件, 按注册顺序 */
	get enabledServices(): Service[] {
		return this.enabledEntities();
	}

	/** 释放栅栏: 宿主进入释放流程后不再接受状态变更 */
	async load(id: string): Promise<void> {
		if (this.released) throw new StateError("服务插件宿主正在释放, 不再接受状态变更");
		return super.load(id);
	}

	async unload(...ids: string[]): Promise<void> {
		if (this.released) throw new StateError("服务插件宿主正在释放, 不再接受状态变更");
		return super.unload(...ids);
	}

	/**
	 * 同步服务插件运行状态: 让运行状态收敛到期望状态
	 * @param desired 期望启用的服务插件 id 列表, 缺省读持久化状态(全部注册服务减去显式停用的)。
	 *   显式传入只对本次生效、不写盘, 任何后续收敛(含页面刷新触发的默认收敛)都会回到持久化名单
	 * @returns 期望启用但没能跑起来的服务插件 id(未注册、依赖被停用或加载失败)
	 */
	async syncState(desired?: string[]): Promise<string[]> {
		return this.serialize(() => {
			// 期望名单在队列**内部**求解: 排队期间用户可能刚改过状态(setEnabled),
			// 在调用点取快照会把那次改动反向拉回
			const wanted = new Set(desired ?? this.state.resolve([...this.registry.keys()]));
			return this.convergeState(wanted);
		});
	}

	/**
	 * 设置服务插件的期望启用状态
	 *
	 * 与 `Bot.setPluginEnabled` 同语义: 先把运行态收敛成功, 再写入期望态;
	 * 收敛失败就抛错、不落盘 —— 文件里不应留下一条做不到的期望。
	 *
	 * 依赖连带(与 load/unload 自身的递归语义一致, 保证运行态与名单同一口径):
	 * - 停用: 依赖它才能运行的服务会被递归卸载, 这些 id 一并记入停用名单
	 * - 启用: 它依赖的服务会被递归加载, 这些 id 一并移出停用名单
	 */
	async setEnabled(id: string, enabled: boolean): Promise<ServiceToggleResult> {
		return this.serialize(async () => {
			const service = this.registry.get(id);
			if (!service) throw new Error(`服务插件 ${id} 未被索引`);
			if (service.status === "loading" || service.status === "unloading") {
				throw new StateError(`服务插件 ${id} 正在切换状态, 请稍后再试`);
			}

			// 连带名单只算"真的被改变"的那些: 本来就开着的依赖、本来就关着的依赖者
			// 不构成变化(load/unload 对它们都是幂等空操作), 也不该被写进期望
			if (enabled) {
				const deps = this.collectDependencies(id);
				const before = this.statusesOf(deps);
				try {
					await this.load(id); // 停用中的依赖由 load 递归拉起
				} catch (e) {
					// 收敛失败: 只把本次真被拉起的依赖对齐回期望, 目标自身保持原期望
					// (它起不来是"这一次没成功", 不是"以后都别启用")
					await this.alignStateWithRuntime(deps, before);
					throw e;
				}
				const changed = deps.filter(dep => before.get(dep) !== "enabled" && this.registry.get(dep)?.status === "enabled");
				await this.state.setEnabledMany([id, ...changed], true);
				return { id, enabled: this.registry.get(id)?.status === "enabled", affected: changed };
			}

			const dependents = this.collectDependents(id);
			const before = this.statusesOf(dependents);
			try {
				await this.unload(id); // 依赖它的服务由 unload 递归卸载
			} catch (e) {
				// 同上: 已经被连带卸载的依赖者按运行态对齐, 目标自身保留原期望
				await this.alignStateWithRuntime(dependents, before);
				throw e;
			}
			const changed = dependents.filter(dep => before.get(dep) === "enabled" && this.registry.get(dep)?.status !== "enabled");
			await this.state.setEnabledMany([id, ...changed], false);
			return { id, enabled: this.registry.get(id)?.status === "enabled", affected: changed };
		});
	}

	/** 取一组服务的当前运行状态 */
	private statusesOf(ids: readonly string[]): Map<string, PluginStatus> {
		return new Map(ids.map(id => [id, this.registry.get(id)?.status ?? "registered"]));
	}

	/**
	 * 把一批服务的期望态对齐到本次操作**真正改变**的那些
	 *
	 * 用在启停中途失败的补救路径上: 递归加载/卸载可能已经改变了运行态, 而
	 * "先收敛成功再落盘"的落盘不会发生 —— 不理会的话, 文件与运行态就各说各话。
	 *
	 * 只处理状态真的变了的 id: 本来就没运行、也不在停用名单里的服务是它自己
	 * 的加载问题(syncState 的"一次失败不写成永久停用"), 不该借这次补救变成
	 * 用户的偏好。对齐失败只记日志: 这是补救, 不该再把原始错误盖掉。
	 */
	private async alignStateWithRuntime(ids: readonly string[], before: Map<string, PluginStatus>): Promise<void> {
		const on: string[] = [];
		const off: string[] = [];

		for (const id of ids) {
			const now = this.registry.get(id)?.status ?? "registered";
			if (before.get(id) === now) continue; // 本次没动它
			(now === "enabled" ? on : off).push(id);
		}

		if (!on.length && !off.length) return;

		try {
			if (on.length) await this.state.setEnabledMany(on, true);
			if (off.length) await this.state.setEnabledMany(off, false);
		} catch (e) {
			this.logger.error("启停失败后对齐服务插件期望态也失败", e);
		}
	}

	/**
	 * 把所有会改变运行态的操作排进同一条队列
	 *
	 * 外部改动(syncState)与 WebUI 操作(setEnabled)可能同时发生, 交错执行会出现
	 * "刚启用又被停掉"这类结构性竞争, 因此统一串行。队列内部不再调用本方法。
	 */
	private serialize<T>(task: () => Promise<T>, allowReleased = false): Promise<T> {
		const run = this.toggling.then(() => {
			// 已进入释放流程: 队列里剩下的启停/收敛不再执行 —— 否则关闭之后还会把服务拉起来
			if (this.released && !allowReleased) {
				throw new StateError("服务插件宿主正在释放, 不再接受状态变更");
			}
			return task();
		});
		this.toggling = run.then(() => undefined, () => undefined);
		return run;
	}

	/** 依赖闭包里被显式停用的服务 id(含传递依赖); 不含自身 */
	private stoppedDependencies(id: string): string[] {
		const seen = new Set<string>([id]);
		const stopped = new Set<string>();
		const queue: string[] = [id];

		while (queue.length) {
			const service = this.registry.get(queue.shift()!);
			if (!service) continue;

			for (const depId of Object.keys(service.manifest.dependencies ?? {})) {
				if (seen.has(depId)) continue;
				seen.add(depId);
				if (this.state.isDisabled(depId)) stopped.add(depId);
				queue.push(depId);
			}
		}

		return [...stopped];
	}

	/** 依赖指定服务的全部服务(含传递依赖者), 停用时用于连带; 不含自身 */
	private collectDependents(id: string): string[] {
		// 根部先算已访问: 自依赖/成环时不把自己当成自己的依赖者
		const seen = new Set<string>([id]);
		const queue: string[] = [id];

		while (queue.length) {
			for (const dependent of this.getDependents(queue.shift()!)) {
				if (seen.has(dependent.id)) continue;
				seen.add(dependent.id);
				queue.push(dependent.id);
			}
		}

		// 去掉根部自身: seen 里带上它只是为了防环
		seen.delete(id);
		return [...seen];
	}

	/** 指定服务依赖的全部服务(含传递依赖), 启用时用于连带; 不含自身 */
	private collectDependencies(id: string): string[] {
		// 根部先算已访问: 依赖环里不把自己当成自己的依赖
		const seen = new Set<string>([id]);
		const queue: string[] = [id];

		while (queue.length) {
			const service = this.registry.get(queue.shift()!);
			if (!service) continue;

			for (const depId of Object.keys(service.manifest.dependencies ?? {})) {
				if (seen.has(depId)) continue;
				seen.add(depId);
				queue.push(depId);
			}
		}

		// 去掉根部自身: seen 里带上它只是为了防环
		seen.delete(id);
		return [...seen];
	}

	/**
	 * 事件过滤: 任一服务插件的过滤器返回 false, 该事件不再进入处理链
	 */
	filterEvent(event: BotEvents, bot: Bot, meta: BotEventMeta): boolean {
		for (const service of this.enabledServices) {
			if (!service.context?.filterEvent(event, bot, meta)) return false;
		}
		return true;
	}

	/**
	 * 事件观察: 通知所有已启用服务插件的观察回调
	 *
	 * 由事件派发链在**过滤结果已知**之后调用, 不论结果如何 —— 是否把被拦下的事件
	 * 交给某个观察者, 由观察者注册时的 `includeFiltered` 决定(见 `ctx.event.observe`)。
	 */
	observeEvent(event: BotEvents, bot: Bot, meta: BotEventMeta, accepted: boolean) {
		for (const service of this.enabledServices) {
			service.context?.observeEvent(event, bot, meta, accepted);
		}
	}

	/**
	 * 用全局指令表匹配消息
	 */
	execCommand(msg: Message): string | false {
		return this.command.exec(msg);
	}

	/**
	 * 卸载全部服务插件, 幂等
	 *
	 * 供 Core.close 调用: 由 Core 管理的生命周期, 终点也在这里。
	 */
	async dispose(): Promise<void> {
		// 幂等: 并发/重复调用等的是同一次释放(首次调用里的 `??=` 保证只有一个任务)
		this.disposing ??= (async () => {
			this.released = true;

			// 排进同一条队列: 等在途的启停跑完, 也避免与它们交错。
			// 已置 released 标志, 队列里剩下的启停/收敛会被跳过。
			await this.serialize(async () => {
				for (const service of [...this.registry.values()].reverse()) {
					try {
						// 直接走 unloadTree: 公共 unload 在 released 后会拒绝执行
						await this.unloadTree(service.id, []);
					} catch (e) {
						this.logger.error(`释放服务插件 ${service.id} 失败: ${e instanceof Error ? e.message : e}`);
					}
				}
			}, true);

			// 状态文件监听也要随宿主一起停掉, 否则关闭后残留的监听仍会触发收敛
			this.unwatchState?.();
			this.unwatchState = null;
			this.state.close();
		})();

		return this.disposing;
	}
}
