import { Cron, type CronOptions } from "croner";
import { uuid } from "./uuid";

type ErrorHandler = (error: unknown, job: Cron) => void;

export type CronJob = {
	name: string,
	pause: () => void,
	resume: () => void,
	stop: () => void,
	trigger: () => Promise<void>,
	nextRun: () => Date | null,
	isBusy: () => boolean,
	isStopped: () => boolean,
}

export class CronManager {
	private tasks = new Map<string, Cron>();
	/** 已停止但 handler 仍在跑的任务: 出表后仍需被 waitIdle 看见 */
	private draining = new Set<Cron>();
	private _errorHandlers = new Set<ErrorHandler>();

	schedule(expression: string | Date, handler: () => void, options: CronOptions = {}): CronJob {
		const name = options.name ?? uuid().replaceAll("-", "").slice(0, 8); // 没有name取8位uuid

		if (this.tasks.has(name)) {
			throw new Error(`Cron job with name "${name}" already exists`);
		}

		const opts: CronOptions = {
			protect: true,          // 默认值，允许 options 覆盖
			paused: false,           // 默认值，允许 options 覆盖
			...options,
			name,                   // 保证一定有 name
			catch: (error, job) => this._handleError(error, job),  // 强制走统一错误出口
		};

		const job = new Cron(expression, opts, handler);
		this.tasks.set(name, job);

		return {
			name,
			pause: () => job.pause(),
			resume: () => job.resume(),
			// 停止并出表: 不出表则 tasks 只增不减, 同名任务在 stop 后也永远无法重建
			stop: () => this._stop(name, job),
			trigger: () => job.trigger(),
			nextRun: () => job.nextRun(),
			isBusy: () => job.isBusy(),
			isStopped: () => job.isStopped(),
		};
	}

	onError(handler: ErrorHandler): () => void {
		this._errorHandlers.add(handler);
		return () => {
			this._errorHandlers.delete(handler);
		};
	}

	private _handleError(error: unknown, job: Cron) {
		// 没挂处理器时不能坐视不管: 默认走控制台, 否则任务异常会完全静默
		if (this._errorHandlers.size === 0) {
			console.error(`[CronManager] 任务 "${job.name ?? "<unnamed>"}" 执行出错:`, error);
			return;
		}
		for (const h of [...this._errorHandlers]) {
			try {
				h(error, job);
			} catch (e) {
				// 错误处理器自己出错，不能中断其他处理器
				console.error("[CronManager] error handler threw:", e);
			}
		}
	}

	/** 停止单个任务并出表; 仍在运行的 handler 记入 draining, 交给 waitIdle 等待 */
	private _stop(name: string, job: Cron) {
		job.stop();
		if (job.isBusy()) this.draining.add(job);
		if (this.tasks.get(name) === job) this.tasks.delete(name);
	}

	stopAll() {
		for (const name of [...this.tasks.keys()]) {
			const job = this.tasks.get(name);
			if (job) this._stop(name, job);
		}
	}

	clear() {
		// 只清表不停止会让调度活着却再没人能停它
		this.stopAll();
	}

	/** 等待运行中的任务结束，用于优雅关闭 */
	async waitIdle(timeoutMs = 30_000): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			for (const job of this.draining) {
				if (!job.isBusy()) this.draining.delete(job);
			}
			const busy = [...this.tasks.values()].some((j) => j.isBusy());
			if (!busy && this.draining.size === 0) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return false;
	}
}
