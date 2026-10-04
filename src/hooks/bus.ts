import Logger from "../utils/logger";
import type { HookBeforeResult, HookCallback, Hooks } from "./types";

/**
 * Hook 总线
 *
 * 框架在关键流程节点(初始化/启停/消息/指令)埋点, 服务插件可在这些节点注册
 * handler 以"接地"框架流程。语义与 `ctx.event.filter` 一致: handler 返回
 * `{ cancel: true }` 表示取消该动作(见 `HookBeforeResult`), 修改数据的能力留待后续。
 *
 * - 注册按顺序存储, 取消时立即停止调用剩余的 handler;
 * - handler 抛错按"放行"处理并记录日志 —— 埋点不应因一个出错的处理而让主流程中断;
 * - `register` 返回注销函数, 便于上下文在释放时统一清理。
 */
export class HookBus {
	private readonly logger = new Logger("HookBus");

	/** 存放hook的映射 name -> 处理器数组 */
	private hooks = new Map<keyof Hooks, Array<HookCallback<unknown>>>();

	/**
	 * 分发某 hook: 按注册顺序调用全部 handler, 任一返回 `{ cancel: true }` 则
	 * 停止调用剩余 handler 并返回 true。
	 * @param name hook 名
	 * @param data 该 hook 的载体参数
	 * @returns 是否被某个 handler 取消
	 */
	dispatch<N extends keyof Hooks>(name: N, data: Parameters<Hooks[N]>[0]): boolean {
		const handlers = this.hooks.get(name);
		if (!handlers || handlers.length === 0) return false;

		for (const handler of handlers) {
			// handler 按约定是同步的 (见 HookCallback), 但插件完全可能写出 async 函数:
			// 它 reject 时不会进到下面的 catch, 会冒成 unhandledRejection, 最终在
			// app.ts 的兜底里把整个进程拖崩。这里把同步/异步两种返回分开处理:
			let result: unknown;
			try {
				result = handler(data);
			} catch (e) {
				this.logger.error(`Hook ${String(name)} handler error:`, e);
				continue;
			}

			// 异步 handler: 挂一个兜底把拒绝记成日志, 绝不让它拖崩进程;
			// 异步返回的 cancel 在同步流程里无法兑现, 一并告警, 免得作者以为取消生效了
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				(result as Promise<unknown>).catch((e) => {
					this.logger.error(`Hook ${String(name)} async handler error:`, e);
				});
				this.logger.warn(`Hook ${String(name)} 的 handler 返回了 Promise: 异步取消不被支持, 已按放行处理`);
				continue;
			}

			if (result && typeof result === "object" && (result as HookBeforeResult).cancel === true) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 注册某 hook 的 handler, 返回注销函数。
	 * @param name hook 名
	 * @param handler 处理器
	 */
	register<N extends keyof Hooks>(name: N, handler: Hooks[N]): () => void {
		const arr = this.hooks.get(name) ?? [];
		if (arr.length === 0) this.hooks.set(name, arr);
		arr.push(handler as HookCallback<unknown>);
		return () => {
			const list = this.hooks.get(name);
			if (!list) return;
			const idx = list.indexOf(handler as HookCallback<unknown>);
			if (idx === -1) return;
			list.splice(idx, 1);
			if (list.length === 0) this.hooks.delete(name);
		};
	}
}
