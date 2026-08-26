import fs from "fs/promises"

/**
 * mkdir封装
 * @param path 目标目录
 */
export function dirCheck(path: string) {
	return fs.mkdir(path, { recursive: true })
}