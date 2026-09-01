import { readFile, writeFile } from "fs/promises";
import path from "path";
import json5 from "json5";
import { dirCheck } from "./dir-check";

export async function readJSON(file: string) {
	return json5.parse(await readFile(file, "utf-8"))
}

/**
 * 读取 JSON 配置文件; 文件不存在时按 defaults 生成默认配置并返回。
 * 仅在文件缺失 (ENOENT) 时重建; 其他错误 (语法错误、权限等) 照常抛出, 不静默覆盖。
 * @returns created 为 true 表示文件缺失, 已重新生成默认配置
 */
export async function readJSONOrCreate<T>(file: string, defaults: T): Promise<{ config: T; created: boolean }> {
	try {
		return { config: await readJSON(file) as T, created: false };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;

		await dirCheck(path.dirname(file));
		await writeFile(file, JSON.stringify(defaults, null, "\t") + "\n", "utf-8");
		return { config: defaults, created: true };
	}
}
