import fs from "fs/promises";
import path from "path";
import json5 from "json5";
import Logger from "../utils/logger";
import type { BotState } from "./types";

const logger = new Logger("BotState");

const DEFAULT_STATE: BotState = { enable: false, plugins: {} };

/**
 * Bot 持久化状态封装: 以 state.json 为后端, 通过 Proxy 提供透明的读写。
 *
 * 对 state 任意字段(含嵌套)的修改只更新内存, **不会自动落盘**;
 * 需要持久化时必须显式调用 save()。
 *
 * 使用方式:
 * ```ts
 * const file = new BotStateFile(statePath, initialState);
 * file.proxy.enable = true;            // 仅修改内存
 * file.proxy.plugins["ping"] = false;  // 嵌套修改同样仅改内存
 * await file.save();                   // 显式保存到 state.json
 * await file.reload();                 // 从文件重读, proxy 引用不变
 * ```
 */
export class BotStateFile {
	/** 代理底层的真实状态对象 */
	private target: BotState;

	/** 对外暴露的状态代理: 修改任意字段只改内存, 需显式 save() 落盘 */
	readonly proxy: BotState;

	/** 子对象代理缓存: 同一对象返回同一代理, 保证 === 比较稳定 */
	private proxies = new WeakMap<object, object>();

	/** 串行化写链: 避免并发写同一文件 */
	private writing: Promise<void> = Promise.resolve();

	constructor(private file: string, initial: BotState) {
		this.target = {
			enable: initial.enable === true,
			plugins: { ...(initial.plugins ?? {}) },
		};
		this.proxy = this.wrap(this.target);
	}

	/**
	 * 显式保存: 将当前内存状态写入 state.json。
	 * 在写链尾部追加一次写(每次写最新快照, 天然串行)。
	 */
	async save(): Promise<void> {
		this.writing = this.writing.then(() => this.write());
		return this.writing;
	}

	/**
	 * 从文件重新读取并替换当前状态(不触发写回)。
	 * 文件缺失/损坏时回退默认状态。
	 * 注意: reload 后旧子对象引用(如之前持有的 plugins 对象)失效, 应重新读取。
	 */
	async reload() {
		const fresh = await this.read();
		// 原地替换 target 内容, 保持 proxy 引用不变
		for (const key of Reflect.ownKeys(this.target)) {
			Reflect.deleteProperty(this.target, key);
		}
		Object.assign(this.target, fresh);
		this.proxies = new WeakMap(); // 使旧子对象代理失效
	}

	/** 对任意对象建立代理: 深层修改也能被捕获 */
	private wrap<T extends object>(obj: T): T {
		const cached = this.proxies.get(obj);
		if (cached) return cached as T;

		const proxy = new Proxy(obj, {
			get: (target, key, receiver) => {
				const value = Reflect.get(target, key, receiver);
				return (value !== null && typeof value === "object") ? this.wrap(value) : value;
			},
			set: (target, key, value) => {
				Reflect.set(target, key, value);
				return true;
			},
			deleteProperty: (target, key) => {
				Reflect.deleteProperty(target, key);
				return true;
			},
		});
		this.proxies.set(obj, proxy);
		return proxy;
	}



	/** 原子写: 先写临时文件再重命名覆盖, 避免写坏原文件 */
	private async write() {
		const data = JSON.stringify(this.target, null, "\t") + "\n";
		const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.tmp`);
		try {
			await fs.writeFile(tmp, data, "utf-8");
			await fs.rename(tmp, this.file);
			logger.debug(`状态已保存: ${this.file}`);
		} catch (e) {
			// 写盘失败不打断运行, 仅记录
			logger.error(`状态保存失败: ${this.file}`, e);
		}
	}

	/** 读取状态文件; 缺失或损坏时回退默认 */
	private async read(): Promise<BotState> {
		try {
			const parsed = json5.parse(await fs.readFile(this.file, "utf-8")) as BotState;
			if (!parsed || typeof parsed !== "object") return { ...DEFAULT_STATE, plugins: {} };
			return {
				enable: parsed.enable === true,
				plugins: { ...(parsed.plugins ?? {}) },
			};
		} catch (e) {
			logger.warn(`读取状态文件失败, 使用默认状态: ${this.file}`);
			return { ...DEFAULT_STATE, plugins: {} };
		}
	}
}
