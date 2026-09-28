import type { PluginEventAPI, PluginEventFilter, PluginEventObserver } from "../types";

/**
 * 事件 API 实现: 把过滤器与观察回调注册进上下文
 *
 * 过滤器与观察回调的实际执行在上下文(以及宿主层)完成, 这里只负责登记,
 * 与 MessageAPI 的分工一致。
 */
export class EventAPI implements PluginEventAPI {
	constructor(
		private readonly registerFilter: (filter: PluginEventFilter) => void,
		private readonly registerObserver: (observer: PluginEventObserver) => void,
	) { }

	filter(predicate: PluginEventFilter): void {
		this.registerFilter(predicate);
	}

	observe(handler: PluginEventObserver): void {
		this.registerObserver(handler);
	}
}
