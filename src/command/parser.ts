

// 什么?你问我这个为什么是普通对象而不是类?
// 我也不到啊, 这个是重构前的东西

import type { CommandParseConfig } from "./types";

const CommandParser = {
	parse(cmd: string, config: CommandParseConfig = {}): Array<string | number> {
		const finalConfig = {
			argStart: config.argStart ?? 0,
			number: config.number ?? true,
			string: config.string ?? true
		};

		// 截取参数部分的字符串
		let argsStr = "";
		if (finalConfig.argStart && finalConfig.argStart > 0) {
			argsStr = cmd.slice(finalConfig.argStart);
		} else {
			const firstSpaceIndex = cmd.indexOf(' ');
			argsStr = firstSpaceIndex === -1 ? "" : cmd.slice(firstSpaceIndex);
		}
		argsStr = argsStr.trim();

		// 如果没有参数，直接返回空数组
		if (!argsStr) return [];

		// 状态机解析参数
		const arr: Array<string | number> = [];
		let currentArg = "";
		let inQuote: string | null = null; // 记录当前所在的引号类型 (' 或 ")
		let isEscaped = false;             // 记录是否处于转义状态 (\)

		for (const char of argsStr) {
			// 处理转义字符
			if (isEscaped) {
				currentArg += char;
				isEscaped = false;
				continue;
			}

			if (finalConfig.string && char === '\\') {
				isEscaped = true;
				continue;
			}

			// 处理引号包裹
			if (finalConfig.string && (char === '"' || char === "'")) {
				if (inQuote === char) {
					inQuote = null;
				} else if (!inQuote) {
					inQuote = char;
				} else {
					currentArg += char;
				}
				continue;
			}

			// 处理空格分隔
			if (!inQuote && char.trim() === '') {
				if (currentArg.length > 0) {
					arr.push(currentArg);
					currentArg = "";
				}
				continue;
			}

			currentArg += char;
		}

		// 把最后剩下的参数推入数组
		if (currentArg.length > 0) {
			arr.push(currentArg);
		}

		// 4. 处理数字类型转换
		if (finalConfig.number) {
			return arr.map(arg => {
				const strArg = arg as string;
				const num = Number(strArg);
				// 确保不是纯空格或空字符串，且可以成功转为数字
				if (strArg.trim() !== '' && !isNaN(num)) {
					return num;
				}
				return strArg;
			});
		}

		return arr;
	}
}

export default CommandParser;