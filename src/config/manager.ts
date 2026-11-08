import path from "node:path";
import { readProp } from "../utils/readProp";
import { root } from "../utils/root";
import { ConfigBase } from "./base";
import type { ConfigRoot, ConfigValues } from "./types";
import { validateConfig } from "./validate-config";

/**
 * 插件/服务插件配置管理器: 宽松写入 + 可选的 schema 热更新
 *
 * 存储、默认值、规范化(`coerce`)与逐字段通知都在 `ConfigBase`; 这里只保留
 * 插件配置特有的语义:
 *
 * - 写入**不校验**: 未知键丢弃、缺失键保留旧值, 类型检查由 API 层显式调
 *   `validate()`(框架设置则是校验与写入原子的, 见 `SettingsDomain`);
 * - 语法错误**抛出**, 不静默覆盖用户值文件;
 * - 文件缺失时按 schema 默认值建一份;
 * - `data` 是只读视图, 写入一律走 `update()` / `save()`。
 *
 * **刻意不监听值文件的外部改动**: 插件配置几乎都经 WebUI/API 程序化写入,
 * 而每份配置一个 fs.watch 会让几十上百个插件同时启用时句柄与事件成倍放大。
 * 手工编辑值文件需重启对应插件(或走 `load()` 重新载入)才生效。
 */
export class ConfigManager extends ConfigBase {
	constructor(schema: ConfigRoot, file?: string) {
		super(schema, file, {
			label: "ConfigManager",
			onError: "throw",
			createIfMissing: true,
		});
	}

	/**
	 * 取某个配置项的值
	 *
	 * 插件配置特有的便利入口: 支持点号路径与数组下标
	 * (`get("pro-group.group-controls.0.enable")`), 依次尝试
	 * 当前值 → 默认值 → fallback; 返回的是内部引用, 需要副本请自行拷贝。
	 *
	 * @param key 属性路径
	 * @param fallback 当前值与默认值都未命中时的返回值
	 */
	get<T = unknown>(key: string, fallback?: T): T {
		const value = readProp(this.data, key);
		if (value !== undefined) return value as T;

		const preset = readProp(this.defaults(), key);
		return (preset !== undefined ? preset : fallback) as T;
	}

	/**
	 * 从文件载入配置值
	 *
	 * 文件不存在时按 schema 默认值生成一份(目录一并创建);
	 * 读到部分值时, 缺失的键回落到默认值, 未知键丢弃。
	 * 文件存在但解析失败(语法错误、权限等)照常抛出, 不静默覆盖。
	 *
	 * @param file 值文件路径, 缺省用构造时传入的 file
	 */
	async load(file: string = this.file ?? ""): Promise<ConfigValues> {
		return this.loadValues(file);
	}

	/**
	 * 用一份提交值更新配置并落盘
	 *
	 * 前端 getValues() 不产出隐藏项, 所以不能直接用提交值覆盖:
	 * 提交中缺失的已知键保留旧值, 隐藏项不会被抹掉。
	 * (table 例外: 用户提交的行集合就是权威, 整表替换)
	 *
	 * @param submitted 前端提交的配置值
	 */
	async update(submitted: unknown): Promise<ConfigValues> {
		const before = this.data;
		const next = this.coerce(this.schema?.controls ?? [], submitted, before);

		await this.commitValue(next);
		this.notifyChanges(before, next);
		return this.data;
	}

	/**
	 * 热更新 Schema 定义
	 *
	 * @param newSchema 新的 schema 控件定义
	 * @param options.saveAfterUpdate 重构数据后是否立即持久化落盘（默认 true）
	 * @param options.notifyChanges 是否对变更的字段触发 watch 监听回调（默认 true）
	 */
	async updateSchema(
		newSchema: ConfigRoot,
		options: { saveAfterUpdate?: boolean; notifyChanges?: boolean } = {}
	): Promise<ConfigValues> {
		const { saveAfterUpdate = true, notifyChanges = true } = options;

		const oldData = this.data;
		(this as { schema: ConfigRoot }).schema = newSchema;
		const next = this.coerce(newSchema?.controls ?? [], oldData);

		// 只改内存: 是否落盘由 saveAfterUpdate 决定, 不能在 commit 里顺手写掉
		this.replaceValue(next);

		if (notifyChanges) this.notifyChanges(oldData, next);
		if (saveAfterUpdate && this.file) await this.save();
		return this.data;
	}

	/**
	 * 校验一份配置值是否符合控件定义
	 * @param config 待校验的值, 缺省校验当前值
	 */
	validate(config: unknown = this.data) {
		return validateConfig(this.schema, config);
	}

	/**
	 * 保存到文件: 先建目录, 再原子写入
	 *
	 * 写入经过 store 的串行队列: 并发的 update/save 不会交错落盘。落盘的是调用
	 * 这一刻的快照 —— 排队期间内存又被改动时, 本次写的仍是当时那份值。
	 * @param file 目标文件, 缺省用构造时传入的 file
	 */
	async save(file?: string) {
		const target = file ?? this.file;
		if (!target) throw new Error("ConfigManager 未绑定配置文件, 无法保存");
		await this.writeCurrent(target);
	}

	/* ---------- 路径约定 ---------- */

	/**
	 * 插件配置值文件路径: `<Bot目录>/configs/plugins/<插件id>.json`
	 * @param botPath Bot目录(BotConfig.path); 相对路径以项目根为基准
	 * @param pluginId 插件id
	 */
	static fileForPlugin(botPath: string, pluginId: string): string {
		return path.resolve(root, botPath, "configs", "plugins", `${pluginId}.json`);
	}

	/**
	 * 服务插件配置值文件路径: `configs/services/<插件id>.json`
	 *
	 * 服务插件是全局单例, 不归属任何 Bot, 因此值文件也不按 Bot 隔离。
	 * @param serviceId 服务插件id
	 */
	static fileForService(serviceId: string): string {
		return path.resolve(root, "configs", "services", `${serviceId}.json`);
	}

	/**
	 * 服务插件状态文件路径: `configs/services/state.json`
	 *
	 * 与配置文件同目录, 但语义不同: `<插件id>.json` 是配置值(只读定义 + 可写值),
	 * 这份是启停期望态 —— 对齐 Bot 侧 "配置一个文件、状态一个文件" 的划分。
	 */
	static fileForServiceState(): string {
		return path.resolve(root, "configs", "services", "state.json");
	}

	static fileForBot(botPath: string) {
		return path.resolve(root, botPath, "config.json");
	}
}
