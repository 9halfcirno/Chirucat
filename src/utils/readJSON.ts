import { readFile } from "fs/promises";
import json5 from "json5";

/** 读取并解析一份 json5 文件; 文件缺失或语法错误一律抛出, 由调用方决定怎么兜底 */
export async function readJSON(file: string) {
	return json5.parse(await readFile(file, "utf-8"))
}
