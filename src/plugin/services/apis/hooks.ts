import type { HookBus } from "../../../hooks/bus";
import type { Hooks } from "../../../hooks/types";

/**
 * Hook API (仅服务插件可用)
 *
 * 与 `ctx.event` 的分工: `event` 作用于**事件传播层**(Entity 构造之前),
 * `hook` 作用于框架内部更细的流程节点 —— 消息处理、指令执行与各模块启停。
 *
 * 这是只读视图: 只开放 `register`, 不开放 `dispatch` —— 分发是框架自身的职责,
 * 插件只能"接地"监听。注册的 handler 随上下文释放自动注销。
 */
export class HooksAPI {
	constructor(
		private readonly hookBus: HookBus,
		private readonly trackDisposer: (dispose: () => void) => void,
	) { }

	/**
	 * 注册某 hook 的 handler
	 * @param name hook 名, 见 `Hooks`
	 * @param handler 处理器, 返回 `{ cancel: true }` 可取消该 hook 后续将执行的动作
	 * @returns 注销函数, 由上下文在释放时统一调用(也可自行提前调用)
	 */
	register<N extends keyof Hooks>(name: N, handler: Hooks[N]): () => void {
		const unregister = this.hookBus.register(name, handler);
		this.trackDisposer(unregister);
		return unregister;
	}
}
