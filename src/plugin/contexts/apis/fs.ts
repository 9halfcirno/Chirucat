import fs from "fs/promises";
import path from "path";
import type { Stats } from "fs";
import type { PluginFileSystemAPI } from "../types";

export class FileSystemAPI implements PluginFileSystemAPI {
	readonly root: string;
	/**
	 * 创建插件文件系统上下文
	 * @param path 绝对路径
	 */
	constructor(path: string) {
		this.root = path;
	}

	async read(filePath: string, encoding: BufferEncoding): Promise<string> {
		return fs.readFile(this.resolve(filePath), encoding);
	}

	async write(filePath: string, data: string | NodeJS.ArrayBufferView): Promise<void> {
		const target = this.resolve(filePath);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, data);
	}

	async append(filePath: string, data: string | NodeJS.ArrayBufferView): Promise<void> {
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
	 * 将插件路径解析到存储根目录内, 拒绝越界访问
	 * @param filePath 插件传入的路径 (相对 root)
	 * @throws 路径解析到 root 之外时抛出
	 */
	private resolve(filePath: string): string {
		const target = path.resolve(this.root, filePath);
		const rel = path.relative(this.root, target);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`文件系统访问越界: ${filePath}`);
		}
		return target;
	}
}
