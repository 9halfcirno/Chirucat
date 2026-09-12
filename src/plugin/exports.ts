/** 单条插件导出记录: 导出值 + 发布者(上下文), 供释放时做归属校验 */
interface PluginExportEntry {
	value: any;
	/** 发布该导出的上下文实例; null 表示由框架直接写入, 不受归属校验约束 */
	owner: object | null;
}

/**
 * 插件导出注册表: pluginId -> 导出值
 *
 * 生命周期与插件运行时严格对齐:
 * - 条目在插件 `init` 中由 `ctx.exports = ...` 写入, 同时记录发布者上下文
 * - 释放统一由 `PluginContext.dispose()` 负责, 覆盖正常卸载 / 初始化失败 / 注册表丢弃三条路径
 * - 释放带归属校验: 旧上下文不会误删重新加载后新上下文写入的条目
 */
export class PluginExports {
	private readonly entries = new Map<string, PluginExportEntry>();

	/** 发布(或覆盖)某插件的导出 */
	setExports(pluginId: string, value: any, owner: object | null = null) {
		this.entries.set(pluginId, { value, owner });
		return value;
	}

	/**
	 * 释放导出条目
	 * @param pluginId 插件id
	 * @param owner 期望的发布者; 传入时仅当条目属于该发布者才删除(避免旧上下文清掉新上下文的导出)
	 * @returns 是否真的删除了条目
	 */
	releaseExports(pluginId: string, owner?: object): boolean {
		const entry = this.entries.get(pluginId);
		if (!entry) return false;
		if (owner !== undefined && entry.owner !== null && entry.owner !== owner) return false;
		return this.entries.delete(pluginId);
	}

	/** 读取导出值; 未发布或已释放时为 undefined */
	getExports(pluginId: string): any {
		return this.entries.get(pluginId)?.value;
	}

	/** 该插件当前是否有导出 */
	hasExports(pluginId: string): boolean {
		return this.entries.has(pluginId);
	}

	/** 当前提供导出的插件id列表(用于错误提示与诊断) */
	ids(): string[] {
		return [...this.entries.keys()];
	}
}
