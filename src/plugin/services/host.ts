import path from "path";
import type { Bot } from "../../bot/bot";
import { CommandManager } from "../../command/manager";
import { ConfigManager } from "../../config/manager";
import { readConfigDefine } from "../../config/define";
import type { Core } from "../../core";
import type { Message } from "../../entity/message";
import { StateError } from "../../errors/state-error";
import type { BotEvents } from "../../protocols/events";
import { dfs } from "../../utils/dfs";
import Logger from "../../utils/logger";
import { dirCheck } from "../../utils/dir-check";
import { PluginExports } from "../exports";
import { PluginLoader } from "../loader";
import { readManifests } from "../manifest";
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
 * 管理 services/ 目录下的框架级插件: 与 PluginManager 相同的发现 / 依赖 / 加载语义,
 * 但注册表挂在 Core 上而不是某个 Bot 上 —— 一个服务插件在整个进程里只有一份实例,
 * 这正是 service 与"全局目录里的普通插件(每个 Bot 各实例化一份)"的分界。
 *
 * 生命周期由 Core 管理: init 时先于 Bot 扫描并加载(供 Bot 插件 require),
 * close 时后于 Bot 卸载(基础设施最后倒)。
 */
export class ServiceHost {
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
		this.state = new ServiceStateManager(stateFile);
	}

	/** 状态文件路径 */
	get stateFile(): string {
		return this.state.file;
	}

	/**
	 * 覆盖状态文件路径(测试/嵌入式注入用)
	 *
	 * 只在期望态尚未装载时有效 —— 已经读过盘再换文件, 内存态与磁盘就会脱节。
	 * @param file 状态文件路径
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

	/**
	 * 扫描服务插件目录, 创建 Service 实例(不加载模块)。
	 *
	 * 只维护注册表, 不改变任何服务插件的运行状态: 已启用实例不被替换,
	 * 目录中已消失的悬空条目仅清理不在运行中的(非 enabled)。
	 * @param dir 服务插件目录, 相对路径以项目根为基准
	 */
	async scan(dir: string = "services"): Promise<void> {
		// 扫描也排进启停队列: WebUI 的"刷新"可能与一次启停同时发生, 让 scan 与
		// 启停交错会换掉正在加载中的实例(见 syncRegistry)
		return this.serialize(async () => {
			const collected = await readManifests(dir, (e, pluginDir) => {
				this.logger.error(`读取服务插件清单失败: ${pluginDir}`, e);
			});

			// 服务目录只收 type: service 的插件; 其他类型放错地方, 跳过并提示
			for (const [id, manifest] of [...collected]) {
				if (manifest.type === "service") continue;
				this.logger.warn(`services/ 中跳过非 service 类型插件: ${id} (type=${manifest.type ?? "normal"})`);
				collected.delete(id);
			}

			await this.syncRegistry(collected);
			this.checkDependencyCycles();
		});
	}

	/** 用一份清单集合对账注册表 */
	private async syncRegistry(collected: Map<string, PluginManifest>) {
		// 活跃态(enabled/loading/unloading)持有异步流程引用: 既不能替换, 也不能清理
		const ACTIVE: PluginStatus[] = ["enabled", "loading", "unloading"];

		for (const [id, manifest] of collected) {
			const existing = this.registry.get(id);
			if (existing && ACTIVE.includes(existing.status)) {
				// 运行中或正在切换的服务不替换实例, 避免运行态与注册表脱节
				continue;
			}
			// 实例即将被丢弃, 先释放其运行时资源(含对外导出)
			existing?.context?.dispose();
			const service = new Service({ manifest, core: this.core });
			await this.setupConfig(service);
			this.registry.set(id, service);
		}

		// 清理悬空条目: 目录中已消失且不在活跃态的服务
		for (const [id, service] of [...this.registry]) {
			if (!collected.has(id) && !ACTIVE.includes(service.status)) {
				service.context?.dispose();
				this.registry.delete(id);
			}
		}
	}

	/**
	 * 装配服务插件配置
	 *
	 * 定义(controls / default)来自插件自带的 manifest.config 文件, 属于插件代码、只读;
	 * 值文件是全局的: configs/services/<插件id>.json, 不存在时按默认值生成。
	 */
	async setupConfig(service: Service) {
		const define = service.manifest.config;
		if (!define) return;

		const file = path.resolve(service.manifest.path, define);
		try {
			service.configSchema = await readConfigDefine(file);

			const config = new ConfigManager(
				service.configSchema,
				ConfigManager.fileForService(service.id),
			);
			await config.load();
			service.config = config;
		} catch (e) {
			this.logger.error(`装配服务插件 ${service.id} 的配置失败: ${e instanceof Error ? e.message : e}`);
		}
	}

	/** 按 id 取服务插件 */
	resolve(id: string): Service | undefined {
		return this.registry.get(id);
	}

	/** 已启用的服务插件, 按注册顺序 */
	get enabledServices(): Service[] {
		return [...this.registry.values()].filter(s => s.status === "enabled");
	}

	/** 解析服务插件的依赖列表(仅已注册的; 缺失依赖提示后跳过) */
	private getDependencyServices(service: Service): Service[] {
		const deps: Service[] = [];
		for (const depId of Object.keys(service.manifest.dependencies ?? {})) {
			const dep = this.registry.get(depId);
			if (!dep) {
				this.logger.warn(`服务插件 ${service.id} 的依赖 ${depId} 未注册`);
				continue;
			}
			deps.push(dep);
		}
		return deps;
	}

	/** 收集 manifest 中声明但未注册的依赖 id(缺失依赖) */
	private getMissingDependencies(service: Service): string[] {
		const missing: string[] = [];
		for (const depId of Object.keys(service.manifest.dependencies ?? {})) {
			if (!this.registry.has(depId)) missing.push(depId);
		}
		return missing;
	}

	/** 依赖指定服务插件的服务插件列表 */
	private getDependents(id: string): Service[] {
		return [...this.registry.values()].filter(s => s.manifest.dependencies?.[id]);
	}

	/** 全图循环检测: 以每个服务为根跑一次dfs, 发现环就warn(不阻断扫描) */
	private checkDependencyCycles() {
		const reported = new Set<string>();
		for (const service of this.registry.values()) {
			if (reported.has(service.id)) continue;
			const cycle = dfs(service, s => s.id, s => this.getDependencyServices(s));
			if (!cycle) continue;
			cycle.forEach(s => reported.add(s.id));
			this.logger.warn(`检测到服务插件依赖循环: ${cycle.map(s => s.id).join(" -> ")}`);
		}
	}

	/**
	 * 启动指定服务插件: 加载模块并创建上下文, 幂等
	 * @param id 服务插件id
	 */
	async load(id: string): Promise<void> {
		if (this.released) throw new StateError("服务插件宿主正在释放, 不再接受状态变更");

		const service = this.registry.get(id);
		if (!service) throw new Error(`服务插件 ${id} 未被索引`)
		if (service.status === "enabled") return; // 幂等
		if (service.status === "loading" || service.status === "unloading") throw new StateError(`服务插件 ${id} 正在切换状态, 请稍后再试`)

		// 依赖环预检: 存在循环则拒绝加载
		const cycle = dfs(service, s => s.id, s => this.getDependencyServices(s));
		if (cycle) throw new StateError(`服务插件依赖存在循环, 拒绝加载: ${cycle.map(s => s.id).join(" -> ")}`);

		// 依赖缺失预检: 直接依赖未注册则拒绝加载(传递依赖由递归 load 逐层拦截)
		const missing = this.getMissingDependencies(service);
		if (missing.length) {
			throw new StateError(`服务插件 ${id} 的依赖未注册: ${missing.join(", ")}`);
		}

		// 先按依赖顺序递归加载依赖
		for (const dep of this.getDependencyServices(service)) {
			await this.load(dep.id);
		}

		// 进入 loading 前的状态只可能是关态, 失败时恢复到它
		const before = service.status;

		service.status = "loading";
		try {
			// 加载模块(未加载过, 或上次卸载时已释放)
			if (!service.module) {
				// 重新装配配置
				await this.setupConfig(service);

				const loaded = await this.loader.load<ServiceModule>(path.join(service.manifest.path, service.manifest.main));
				if (!loaded?.default) throw new Error(`服务插件 ${id} 没有默认导出`)
				service.module = loaded.default;
			}

			// 启用服务插件
			const context = new ServiceContext(service, this.exports, this.command);
			try {
				await service.enable(context);
			} catch (e) {
				// enable 可能在其内部释放之前就报错, 这里兜底(dispose 幂等)
				context.dispose();
				throw e;
			}

			this.logger.log(`成功载入服务插件: ${service.manifest.name || "???"}(${service.id})`);
		} catch (e) {
			// 构建/启用失败: 回到加载前的关态
			service.status = before;
			throw e;
		}
	}

	/**
	 * 卸载指定服务插件: 释放运行态, 保留注册表条目
	 * @param ids 服务插件id
	 */
	async unload(...ids: string[]) {
		if (this.released) throw new StateError("服务插件宿主正在释放, 不再接受状态变更");

		for (const id of ids) {
			await this.unloadTree(id, []);
		}
	}

	/** 递归卸载: 先卸载依赖该服务插件的服务, 再卸载自身 */
	private async unloadTree(id: string, stack: string[]): Promise<void> {
		if (stack.includes(id)) return; // 依赖环防御, 防止无限递归

		for (const dependent of this.getDependents(id)) {
			await this.unloadTree(dependent.id, [...stack, id]);
		}

		const service = this.registry.get(id);
		if (!service || service.status === "disabled" || service.status === "registered") return; // 幂等
		await service.disable(true);
		// 兜底: 导出正常已由 context.dispose() 释放, 这里覆盖上下文缺失等异常情况
		this.exports.releaseExports(service.id);

		this.logger.log(`已卸载服务插件: ${service.id}`);
	}

	/**
	 * 同步服务插件运行状态: 让运行状态收敛到期望状态
	 * @param desired 期望启用的服务插件 id 列表, 缺省读持久化状态(全部注册服务减去显式停用的)。
	 *   显式传入只对本次生效、不写盘, 任何后续收敛(含页面刷新触发的默认收敛)都会回到持久化名单
	 * @returns 期望启用但没能跑起来的服务插件 id(未注册、依赖被停用或加载失败)
	 */
	async syncState(desired?: string[]): Promise<string[]> {
		return this.serialize(async () => {
			// 期望名单在队列**内部**求解: 排队期间用户可能刚改过状态(setEnabled),
			// 在调用点取快照会把那次改动反向拉回
			const wanted = new Set(desired ?? this.state.resolve([...this.registry.keys()]));

			/** 起不来的服务: 期望里有、运行态给不出来 */
			const failed: string[] = [];

			// 先卸载期望关闭的
			for (const service of [...this.enabledServices]) {
				if (!wanted.has(service.id)) {
					await this.unload(service.id);
				}
			}

			// 再加载期望开启的
			for (const id of wanted) {
				if (!this.registry.has(id)) {
					this.logger.warn(`期望启用但未注册的服务插件: ${id}`);
					failed.push(id);
					continue;
				}

				// 依赖里有被显式停用的服务: 加载会把停用项重新拉起, 与状态文件的
				// 期望直接矛盾(只可能出现在手改文件的场景), 因此拒绝加载并如实报告。
				// 不写盘: 一次启动失败不该把期望改成"以后都别启用"。
				const stopped = this.stoppedDependencies(id);
				if (stopped.length) {
					this.logger.warn(`服务插件 ${id} 的依赖已被停用, 跳过加载: ${stopped.join(", ")}`);
					failed.push(id);
					continue;
				}

				try {
					await this.load(id);
				} catch (e) {
					// 单个服务加载失败不阻断状态收敛, 记录后继续
					this.logger.error(`服务插件 ${id} 加载失败: ${e instanceof Error ? e.message : e}`);
					failed.push(id);
				}
			}

			return failed;
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
	 * @param id 服务插件 id
	 * @param enabled 是否期望启用
	 * @returns 目标收敛后的运行态, 以及被连带变更的服务 id
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
	 * 事件过滤: 任一服务插件的过滤器返回 false, 该事件不再传播
	 * @param event 适配器派发的原始事件
	 * @param bot 收到事件的 Bot
	 * @returns 是否放行
	 */
	filterEvent(event: BotEvents, bot: Bot): boolean {
		for (const service of this.enabledServices) {
			if (!service.context?.filterEvent(event, bot)) return false;
		}
		return true;
	}

	/**
	 * 事件观察: 通知所有已启用服务插件的观察回调
	 * @param event 已通过过滤的事件
	 * @param bot 收到事件的 Bot
	 */
	observeEvent(event: BotEvents, bot: Bot) {
		for (const service of this.enabledServices) {
			service.context?.observeEvent(event, bot);
		}
	}

	/**
	 * 将消息派发给所有已启用服务插件的全局消息回调 (按注册顺序)
	 * @param msg 框架消息
	 */
	handleMessage(msg: Message) {
		for (const service of this.enabledServices) {
			service.context?.handleMessage(msg);
		}
	}

	/**
	 * 用全局指令表匹配消息
	 * @param msg 框架消息
	 * @returns 命中的指令名, 未命中为 false
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
