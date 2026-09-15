import fs from "fs/promises";
import path from "path";
import type { Stats } from "fs";
import type { PluginFileSystemAPI } from "../types";

export class FileSystemAPI implements PluginFileSystemAPI {
	readonly root: string;

	/** 是否允许写操作: 插件代码目录等只读根传 false */
	private readonly _writable: boolean;

	/**
	 * 创建插件文件系统上下文
	 * @param path 绝对路径
	 * @param options.writable 是否允许写入, 缺省 true
	 */
	constructor(path: string, options: { writable?: boolean } = {}) {
		this.root = path;
		this._writable = options.writable ?? true;
	}

	async read(filePath: string, encoding: BufferEncoding): Promise<string> {
		return fs.readFile(this.resolve(filePath), encoding);
	}

	async write(filePath: string, data: string | NodeJS.ArrayBufferView): Promise<void> {
		this.assertWritable(filePath);
		const target = this.resolve(filePath);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, data);
	}

	async append(filePath: string, data: string | NodeJS.ArrayBufferView): Promise<void> {
		this.assertWritable(filePath);
		const target = this.resolve(filePath);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.appendFile(target, data);
	}

	async exists(filePath: string): Promise<boolean> {
		try {
			await fs.access(this.resolve(filePath));
			return true;
		} catch {
			return false;
		}
	}

	async list(filePath = "."): Promise<string[]> {
		return fs.readdir(this.resolve(filePath));
	}

	async stat(filePath: string): Promise<Stats> {
		return fs.stat(this.resolve(filePath));
	}

	/**
	 * 拒绝写入只读根的请求
	 * @param filePath 插件传入的路径, 仅用于报错定位
	 * @throws root 为只读时抛出
	 */
	private assertWritable(filePath: string): void {
		if (this._writable) return;
		throw new Error(`文件系统: '${this.root}' 为只读根, 拒绝写入: ${filePath}`);
	}

	/**
	 * 将插件路径解析到存储根目录内, 拒绝越界访问
	 * @param filePath 插件传入的路径 (相对 root)
	 * @throws 路径解析到 root 之外时抛出
	 */
	private resolve(filePath: string): string {
		const target = path.resolve(this.root, filePath);
		const rel = path.relative(this.root, target);
		// 只认 ".." 路径段: 名为 "..foo" 的合法条目不应被拒
		if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
			throw new Error(`文件系统访问越界: ${filePath}`);
		}
		return target;
	}
}
