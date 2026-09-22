import path from "path";
import { PluginManager } from "../plugin/manager";
import { BotStateManager } from "./state-manager";
import { MessageHandler } from "./message-handler";
import type { BotConfig } from "./types";
import type { BotEventMeta, BotEvents } from "../protocols/events";
import { EntityFactory } from "../entity/factory";
import type { Core } from "../core";
import { CommandManager } from "../command/manager";
import EventEmitter from "events";
import type { BotActions } from "../protocols/actions";
import type { MessageSend } from "../protocols/action/message-send";
import { StateError } from "../errors/state-error";
import Logger from "../utils/logger";

/**
 * 一个 Bot: 一组插件的独立容器
 *
 * 运行态(running / 插件的实际 status)与持久化期望态(`state`)分开:
 * 期望态是 state.json 的权威内容, 运行态只在内存, 由 applyDesired 收敛过来。
 */
export class Bot extends EventEmitter {
	logger: Logger;
	id: string;
	name: string | null = null;
	path: string;
	message = new MessageHandler(this);
	command = new CommandManager({});
	plugin = new PluginManager(this);

	/** 持久化启停状态(期望态) */
	readonly state: BotStateManager;

	/** Bot 是否处于运行中(已启动且未停止) */
	running = false;

	/** 收敛串行化: 外部改动与 WebUI 操作不会交错启停 */
	private applying: Promise<void> = Promise.resolve();

	/** 已释放: 不再响应状态文件变化 */
	private disposed = false;

	/** 取消状态变更监听 */
	private unwatchState: (() => void) | null = null;

	constructor(config: BotConfig, readonly core: Core) {
		super();
		this.logger = new Logger(`Bot ${config.id}`)
		this.path = config.path;
		this.id = config.id;
		this.name = config.name || null;
		this.state = new BotStateManager(path.join(this.path, "state.json"));
	}

	/**
	 * 载入持久化状态并开始监听其变化
	 *
	 * 由 BotManager.scan 在实例创建后调用。开始监听后, 外部(含手工编辑)
	 * 改动 state.json 会自动收敛运行态。
	 */
	async initState() {
		await this.state.load();

		this.unwatchState = this.state.watch(() => {
			// 监听回调不等待收敛, 失败只记录: 外部改动引发的收敛不该打断任何主流程
			void this.applyDesired().catch((e) => {
				this.logger.error("应用状态文件变更失败", e);
			});
		});

		this.state.startWatching();
	}

	/**
	 * 启动Bot: 扫描插件, 并按期望的插件列表启用插件。
	 *
	 * 基本只改变运行态, 不写 state.json —— 期望态由 setEnable 或外部改文件表达。
	 * 例外是起不来的插件: 加载失败的 id 会从期望列表移除(见 dropUnstartable),
	 * 否则文件里记着"开着"、界面上却是"关着"。
	 */
	async start() {
		if (this.running) return; // 幂等

		await this.plugin.scan({ global: "plugins", bot: path.join(this.path, "plugins") });
		await this.dropUnstartable(await this.plugin.syncState());

		this.running = true;
		this.logger.log(`${this.name || this.id} 启动成功`);
	}

	/**
	 * 关闭Bot: 卸载全部启用插件。
	 *
	 * 同样只改运行态, 不写 state.json: 停一次不等于"以后都别启动"。
	 */
	async stop() {
		if (!this.running) return; // 幂等
		this.running = false; // 先置位, 防止重入
		for (const plugin of [...this.plugin.enabledPlugins]) {
			await this.plugin.unload(plugin.id);
		}
		this.logger.log(`${this.name || this.id} 停止成功`);
	}

	/**
	 * 设置期望启用状态(WebUI 等外部入口)
	 *
	 * 先收敛运行态, 成功后才落盘: 避免出现"文件里写着启用, 实际没跑起来"的假启用。
	 * @param enable 是否启用
	 */
	async setEnable(enable: boolean) {
		await this.serialize(async () => {
			enable ? await this.start() : await this.stop();
			await this.state.setEnable(this.running);
		});
	}

	/**
	 * 设置单个插件的期望启用状态
	 *
	 * 与 setEnable 一致: 先收敛(加载/卸载)成功, 再写入偏好。
	 * 插件只能在 Bot 运行时加载, 因此 Bot 未运行时无法更改。
	 * @param id 插件 id
	 * @param enabled 是否启用
	 */
	async setPluginEnabled(id: string, enabled: boolean) {
		await this.serialize(async () => {
			if (!this.running) throw new StateError(`Bot ${this.id} 未运行, 无法更改插件状态`);

			enabled ? await this.plugin.load(id) : await this.plugin.unload(id);
			await this.state.setPluginEnabled(id, enabled);
		});
	}

	/**
	 * 清理起不来的插件: 把期望启用但没跑起来的 id 从期望态移除
	 *
	 * 所见即所得 —— 运行态给不出来的插件不该继续留在 state.json 里, 否则
	 * 界面显示"关着"而文件记着"开着", 下次启动还会再试一遍。插件起不来
	 * 是插件的问题, 靠日志暴露即可, 不需要框架替它保留一份做不到的期望。
	 * @param failed syncState 报告的失败插件 id
	 */
	private async dropUnstartable(failed: readonly string[]) {
		if (!failed.length) return;

		const dropped = await this.state.disablePlugins(failed);
		if (dropped) this.logger.warn(`已从期望启用列表移除起不来的插件: ${failed.join(", ")}`);
	}

	/**
	 * 重新扫描插件目录, 让插件注册表与磁盘对齐
	 *
	 * 只更新注册表, 不加载/卸载任何插件: 已启用插件的实例不被替换, 运行中的插件不受影响,
	 * 也不写 state.json。未运行的 Bot 同样可以扫描(只登记清单, 不加载模块),
	 * 供 WebUI 在启动前展示插件列表。
	 *
	 * 与启停走同一条串行队列: 扫描会替换非启用状态的插件实例并释放其上下文,
	 * 若与正在进行的加载交错, 会把加载到一半的插件拆掉。
	 */
	async refreshPlugins() {
		await this.serialize(() => this.plugin.scan({
			global: "plugins",
			bot: path.join(this.path, "plugins"),
		}));
	}

	/**
	 * 让运行态收敛到持久化的期望态
	 */
	async applyDesired(): Promise<void> {
		await this.serialize(() => this.converge());
	}

	/**
	 * 把所有会改变运行态的操作排进同一条队列
	 *
	 * 外部改动(applyDesired)与 WebUI 操作(setEnable/setPluginEnabled)可能同时发生,
	 * 交错执行会出现“刚启动又被停掉”这类结构性竞争, 因此统一串行。
	 * 队列内部不再调用本方法, 避免自锁。
	 */
	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = this.applying.then(() => {
			// 栅栏: Bot 已释放就不再执行任何运行态变更
			if (this.disposed) throw new StateError(`Bot ${this.id} 已释放, 不再接受状态变更`);
			return task();
		});
		this.applying = run.then(() => undefined, () => undefined);
		return run;
	}

	/** 单次收敛: 先对齐 Bot 启停, 再对齐插件 */
	private async converge() {
		if (this.disposed) return;

		const desired = this.state.get();

		if (desired.enable && !this.running) {
			// start 内部已经 scan + 按期望加载插件, 这里不能再同步一次:
			// 加载失败的插件停在 error 状态, 重复同步会让它把 init 再跑一遍
			await this.start();
			return;
		}

		if (!desired.enable && this.running) {
			await this.stop();
			return;
		}

		// 启停无需变更: 只把插件对齐到期望列表
		if (this.running) await this.dropUnstartable(await this.plugin.syncState(desired.enabledPlugins));
	}

	/**
	 * 从状态文件重读并收敛运行态(供 Core 启动、BotManager 批量收敛使用)
	 */
	async syncState() {
		await this.state.load();
		await this.applyDesired();
	}

	/**
	 * 释放: 停止运行并停止监听状态文件; 幂等
	 *
	 * 删除 Bot 或退出进程前应当调用, 否则残留的监听会在目录消失后继续被触发。
	 */
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;

		// 先立在途任务跑完: 队列里可能正有一次启停进行到一半,
		// 不等它结束就拆监听, 会留下一个已经没有人管的运行态。
		await this.applying.catch(() => { /* 在途任务的失败不影响释放 */ });

		this.unwatchState?.();
		this.unwatchState = null;
		this.state.close();

		if (this.running) await this.stop();
	}

	dispatch(event: BotEvents, meta: BotEventMeta) {
		const entity = EntityFactory.create(event, meta, this);
		if (!entity) return;
		if (entity.type === "message.create") {
			this.message.handle(entity);
		}
	}

	/**
	 * 将Action转发给对应的适配器插件
	 * @param action Action对象
	 * @param adapter 适配器插件的id
	 * @param extra 额外数据, 应从对应event.extra取
	 */
	async action(action: BotActions, adapter: string, extra?: Record<string, any>) {
		if (action.type === "message.send") this.recordSend(action);
		await this.plugin.handleAction(action, adapter, extra);
	}

	/**
	 * 记录一条 Bot 发出的消息
	 *
	 * 统计的是发送动作而非投递结果; 属于辅助功能, 任何失败都不应影响发送主流程,
	 * 会话查不到时直接放弃这条记录。
	 */
	private recordSend(action: MessageSend) {
		const stats = this.core.statistics;
		if (!stats) return;

		const session = this.core.session?.query(action.session);
		if (!session) return;

		stats.recordSend(action, {
			botId: this.id,
			platform: session.platform,
			sessionType: session.type,
		});
	}
}
