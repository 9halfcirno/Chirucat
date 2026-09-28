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
import { PluginExports } from "../exports";
import { PluginLoader } from "../loader";
import { readManifests } from "../manifest";
import type { PluginManifest, PluginStatus } from "../types";
import { Service, type ServiceModule } from "./service";
import { ServiceContext } from "./context";

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

	constructor(private readonly core: Core) { }

	/**
	 * 扫描服务插件目录, 创建 Service 实例(不加载模块)。
	 *
	 * 只维护注册表, 不改变任何服务插件的运行状态: 已启用实例不被替换,
	 * 目录中已消失的悬空条目仅清理不在运行中的(非 enabled)。
	 * @param dir 服务插件目录, 相对路径以项目根为基准
	 */
	async scan(dir: string = "services"): Promise<void> {
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
	}

	/** 用一份清单集合对账注册表 */
	private async syncRegistry(collected: Map<string, PluginManifest>) {
		for (const [id, manifest] of collected) {
			const existing = this.registry.get(id);
			if (existing?.status === "enabled") {
				// 运行中的服务不替换实例, 避免运行态与注册表脱节
				continue;
			}
			// 实例即将被丢弃, 先释放其运行时资源(含对外导出)
			existing?.context?.dispose();
			const service = new Service({ manifest, core: this.core });
			await this.setupConfig(service);
			this.registry.set(id, service);
		}

		// 清理悬空条目: 目录中已消失且不在运行中的服务
		// 活跃态(enabled/loading/unloading)持有异步流程引用, 不清理
		const ACTIVE: PluginStatus[] = ["enabled", "loading", "unloading"];
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
	 * @param desired 期望启用的服务插件 id 列表, 缺省为全部已注册服务
	 * @returns 期望启用但没能跑起来的服务插件 id(未注册或加载失败)
	 */
	async syncState(desired: string[] = [...this.registry.keys()]): Promise<string[]> {
		const wanted = new Set(desired);

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
			try {
				await this.load(id);
			} catch (e) {
				// 单个服务加载失败不阻断状态收敛, 记录后继续
				this.logger.error(`服务插件 ${id} 加载失败: ${e instanceof Error ? e.message : e}`);
				failed.push(id);
			}
		}

		return failed;
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
	async dispose() {
		for (const service of [...this.registry.values()].reverse()) {
			try {
				await this.unload(service.id);
			} catch (e) {
				this.logger.error(`释放服务插件 ${service.id} 失败: ${e instanceof Error ? e.message : e}`);
			}
		}
	}
}
