import fs from "node:fs/promises";
import json5 from "json5";
import type { ConfigRoot } from "./types";

/**
 * 读取插件自带的配置定义文件 (清单里 manifest.config 指向的文件)
 *
 * 该文件同时承担"控件定义"和"默认值"两个角色, 通常带 `$schema` 与注释,
 * 因此用 json5 解析; 它属于插件代码的一部分, 只读, 不由程序回写。
 *
 * @param file 定义文件路径
 * @throws 文件不存在 / 解析失败 / 缺少 controls 数组
 */
export async function readConfigDefine(file: string): Promise<ConfigRoot> {
	const define = json5.parse(await fs.readFile(file, "utf-8")) as ConfigRoot;

	if (!define || typeof define !== "object" || !Array.isArray(define.controls)) {
		throw new Error(`配置定义缺少 controls 数组: ${file}`);
	}
	return define;
}
