import { readProp } from "../../../utils/readProp";
import type { ConfigManager, ConfigValues } from "../../../config/manager";
import type { PluginConfigAPI, PluginConfigWatcher } from "../types";

/**
 * 插件配置的只读视图
 *
 * 写入由 WebUI / 值文件负责: 只读可以避免插件与 WebUI 互相覆盖,
 * 而且插件与 WebUI 共享同一个 ConfigManager 实例, get 永远读到最新值。
 *
 * 插件没有声明 `manifest.config` 时, manager 为 null, 此时按"没有配置"处理
 * (get 返回 fallback, has 为 false, all 为空对象, watch 注册后不会触发), 插件不必判空。
 */
export class PluginConfig implements PluginConfigAPI {
	/** 本上下文注册的取消函数, 上下文释放时统一注销 */
	private readonly unwatchers: (() => void)[] = [];

	constructor(private readonly manager: ConfigManager | null = null) { }

	get<T = unknown>(key: string, fallback?: T): T {
		if (!this.manager) return fallback as T;
		return this.manager.get<T>(key, fallback);
	}

	has(key: string): boolean {
		return this.manager ? readProp(this.manager.data, key) !== undefined : false;
	}

	all(): ConfigValues {
		return this.manager ? this.manager.values() : {};
	}

	watch(handler: PluginConfigWatcher): () => void {
		if (!this.manager) return () => { };

		const unwatch = this.manager.watch(handler);
		this.unwatchers.push(unwatch);

		return () => {
			unwatch();
			const index = this.unwatchers.indexOf(unwatch);
			if (index >= 0) this.unwatchers.splice(index, 1);
		};
	}

	/** 注销全部监听, 幂等 (由 PluginContext.dispose 调用) */
	dispose() {
		for (const unwatch of this.unwatchers.splice(0)) unwatch();
	}
}
