import { StateError } from "../../../errors/state-error";
import type { PluginMemoryAPI } from "../types";

/**
 * 跨重载暂存的一份桶
 *
 * 桶由宿主持有(见 `ManagedHostBase.memoryFor`), 上下文只是它的一个视图: 插件重载后
 * 新上下文拿到同一个桶, 所以上一次写进来的东西还在。
 */
export class PluginMemory implements PluginMemoryAPI {
	constructor(private readonly bucket: Map<string, unknown>) {}

	get<T = unknown>(key: string, defaultValue?: T): T | undefined {
		if (!this.bucket.has(key)) return defaultValue;
		return structuredClone(this.bucket.get(key)) as T;
	}

	set(key: string, value: unknown): void {
		this.bucket.set(key, copyIn(value, key));
	}

	has(key: string): boolean {
		return this.bucket.has(key);
	}

	delete(key: string): boolean {
		return this.bucket.delete(key);
	}

	keys(): string[] {
		return [...this.bucket.keys()];
	}

	entries(): [string, unknown][] {
		return [...this.bucket].map(([key, value]) => [key, structuredClone(value)]);
	}

	size(): number {
		return this.bucket.size;
	}
}

/**
 * 复制一份写进来的值, 顺带把"存了等于没存"的形状挡在外面
 *
 * 只靠 `structuredClone` 不够: 它对函数会抛错(正是想要的), 但对循环引用是**照单全收**
 * 地复制整个环。而环一般意味着插件把活动对象(msg / entity / ctx)存了进来 —— 那等于
 * 把整张对象图钉进内存, 存下的还是此后永不更新的死快照。所以先自己走一遍再复制。
 */
function copyIn(value: unknown, key: string): unknown {
	assertStorable(value, key);
	try {
		return structuredClone(value);
	} catch (e) {
		throw new StateError(`memory: 写入键 ${key} 失败, 值不可复制 (${e instanceof Error ? e.message : e}); 只放纯数据, 其余请改用 ctx.kv 或插件自己的字段`);
	}
}

/**
 * 递归检查值里有没有不可暂存的东西
 *
 * `path` 只记**当前这条递归链**上的对象(进入时压、离开时弹): 同一对象出现在两个兄弟
 * 分支里不是环, 那种形状是合法的, 不能误伤。
 */
function assertStorable(value: unknown, key: string, path: unknown[] = []): void {
	if (typeof value === "function" || typeof value === "symbol") {
		throw new StateError(
			`memory: 写入键 ${key} 失败, 值里有${typeof value === "function" ? "函数" : "Symbol"}` +
			`; 暂存只收纯数据, 回调请改为在 init 里按数据重新注册`);
	}

	if (value === null || typeof value !== "object") return;

	if (path.includes(value)) {
		throw new StateError(
			`memory: 写入键 ${key} 失败, 值里有循环引用; 八成是把活动对象(msg / entity / ctx)存进来了, 请只存需要的字段`);
	}

	path.push(value);
	for (const item of Object.values(value)) assertStorable(item, key, path);
	path.pop();
}
