import Logger from "../utils/logger";
import type { AfterHooks, BeforeHooks, HookBeforeResult, Hooks } from "./types";

/**
 * Hook 总线
 *
 * 框架在关键流程节点(初始化/启停/消息/指令/动作)埋点, 服务插件可在这些节点注册
 * handler 以"接地"框架流程。
 *
 * 钩子分两类, 分发方法也分开 —— 这是**类型上的区分**, 不只是文档约定:
 * - **before 类**(`BeforeHooks`): 事情还没发生, 走 {@link dispatch}, 可以返回
 *   `{ cancel: true }` 拦住; 一旦取消, 后面的 handler 不再调用;
 * - **after 类**(`AfterHooks`): 事情已经发生, 走 {@link notify}, 返回值被忽略,
 *   全部 handler 都会被调用(不短路)。
 *
 * 混用会编译失败: 把 after 钩子交给 `dispatch` 或把 before 钩子交给 `notify` 都过不了
 * 类型检查。这样"after 不能取消"就不必靠作者记住注释。
 *
 * 另一条贯穿两类的规则: handler 抛错只记日志, 不中断后续 —— 埋点不该因一个出错的
 * 处理器把主流程拖垮。
 */
export class HookBus {
	private readonly logger = new Logger("HookBus");

	/**
	 * 内部存储用的统一签名
	 *
	 * 两类 handler 的返回值不同(before 可返回结果对象, after 只有 void), 存的时候
	 * 按最宽的签名收; 具体约束由 `register` / `dispatch` / `notify` 的泛型负责。
	 */
	private hooks = new Map<keyof Hooks, Array<(data: never) => unknown>>();

	/**
	 * 分发一个 before 类钩子
	 *
	 * 按注册顺序调用 handler, 任一返回 `{ cancel: true }` 则停止调用剩余 handler
	 * 并返回 true。
	 * @param name hook 名
	 * @param data 该 hook 的载体参数
	 * @returns 是否被某个 handler 取消
	 */
	dispatch<N extends keyof BeforeHooks>(name: N, data: Parameters<BeforeHooks[N]>[0]): boolean {
		const handlers = this.hooks.get(name);
		if (!handlers || handlers.length === 0) return false;

		for (const handler of handlers) {
			// handler 按约定是同步的 (见 HookCallback), 但插件完全可能写出 async 函数:
			// 它 reject 时不会进到下面的 catch, 会冒成 unhandledRejection, 最终在
			// app.ts 的兜底里把整个进程拖崩。这里把同步/异步两种返回分开处理:
			let result: unknown;
			try {
				result = handler(data as never);
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
	 * 通知一个 after 类钩子
	 *
	 * 调用**全部** handler, 忽略返回值, 不短路。事情已经发生, 取消没有意义; 而短路
	 * 会让后注册的插件静默收不到通知 —— 是否能收到取决于注册顺序, 排起来极难。
	 *
	 * 单个 handler 抛错同样只记日志, 不影响其他订阅者。
	 */
	notify<N extends keyof AfterHooks>(name: N, data: Parameters<AfterHooks[N]>[0]): void {
		const handlers = this.hooks.get(name);
		if (!handlers || handlers.length === 0) return;

		for (const handler of handlers) {
			let result: unknown;
			try {
				result = handler(data as never);
			} catch (e) {
				this.logger.error(`Hook ${String(name)} handler error:`, e);
				continue;
			}

			// 异步 handler 的拒绝绝不能让进程崩掉; 通知类钩子不需要它的返回值
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				(result as Promise<unknown>).catch((e) => {
					this.logger.error(`Hook ${String(name)} async handler error:`, e);
				});
			}
		}
	}

	/**
	 * 注册某 hook 的 handler, 返回注销函数。
	 *
	 * 两类钩子共用这一个入口: 名字本身就是 `before.*` / `after.*`, 再按类拆两个
	 * `register` 只是让调用方多记一个方法。约束在分发侧 —— 交给 `dispatch` 的名字
	 * 必须来自 `BeforeHooks`, 交给 `notify` 的必须来自 `AfterHooks`。
	 * @param name hook 名
	 * @param handler 处理器
	 */
	register<N extends keyof Hooks>(name: N, handler: Hooks[N]): () => void {
		const arr = this.hooks.get(name) ?? [];
		if (arr.length === 0) this.hooks.set(name, arr);

		const entry = handler as (data: never) => unknown;
		arr.push(entry);

		return () => {
			const list = this.hooks.get(name);
			if (!list) return;
			const idx = list.indexOf(entry);
			if (idx === -1) return;
			list.splice(idx, 1);
			if (list.length === 0) this.hooks.delete(name);
		};
	}
}
