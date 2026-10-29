import type { CronOptions } from "croner";
import type { CronJob, CronManager } from "../../../utils/cron-manager";
import type { PluginCronAPI } from "../types";
import { StateError } from "../../../errors/state-error";
import type Logger from "../../../utils/logger";

/** dispose 时等待运行中 handler 收尾的兜底上限 */
const DRAIN_TIMEOUT = 5_000;

/**
 * 插件作用域的定时任务视图
 *
 * 普通插件与 ServiceContext 共用同一份实现, 免得生命周期规则各写一遍:
 * - 注册前校验上下文可用、Core 的调度器仍在;
 * - 记录本上下文创建的 job, 卸载时据此停止(不记录就会留下卸载后仍在跑的幽灵任务);
 * - 停止时等待正在运行的 handler 收尾, 超时只告警、不阻断后续释放。
 */
export class CronScope implements PluginCronAPI {
	/** 本上下文创建的 job; 停止后出表, 不在已释放的作用域里留引用 */
	private readonly registered = new Set<CronJob>();

	constructor(
		private readonly assertAlive: (action: string) => void,
		private readonly resolveManager: () => CronManager | null,
	) { }

	schedule(expression: string | Date, handler: () => void, options: CronOptions = {}): CronJob {
		this.assertAlive("注册定时任务");
		const manager = this.resolveManager();
		// Core 关闭后 cron 会置空: 时报 TypeError 只会让人去猜, 这里给出明确原因
		if (!manager) throw new StateError("Cron 调度器未就绪或已关闭, 无法注册定时任务");

		const job = manager.schedule(expression, handler, options);
		this.registered.add(job);
		return job;
	}

	jobs(): CronJob[] {
		return [...this.registered];
	}

	/**
	 * 停止本作用域的全部任务, 并等待运行中的 handler 收尾
	 *
	 * 无论 job 是否已被插件自己 stop 过, 只要 handler 还在跑就计入等待 ——
	 * 否则"插件先 stop、代码仍在执行"这一路径会被漏掉。
	 */
	async stopAll(logger: Logger): Promise<void> {
		const busy: CronJob[] = [];

		for (const job of this.registered) {
			job.stop();
			if (job.isBusy()) busy.push(job);
		}
		this.registered.clear();

		if (busy.length === 0) return;

		const deadline = Date.now() + DRAIN_TIMEOUT;
		while (Date.now() < deadline && busy.some((j) => j.isBusy())) {
			await new Promise((r) => setTimeout(r, 100));
		}

		for (const job of busy) {
			if (job.isBusy()) {
				logger.warn(`Job "${job.name}" 停止后 ${DRAIN_TIMEOUT}ms 仍在运行`);
			}
		}
	}
}
