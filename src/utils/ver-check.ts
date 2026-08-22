export type VerCheckOp =
	| ">"
	| "<"
	| "="
	| ">="
	| "<="
	| "!="
	| "any"

const VerChecker = {
	check(oriVer: string, com: VerCheckOp, tarVer: string): boolean {
		if (tarVer === "any") return true;
		const ori = oriVer.split(".");
		const tar = tarVer.split(".");

		// 取两个版本号中较长的长度
		const maxLength = Math.max(ori.length, tar.length);

		let diff = 0;

		// 逐位比较
		for (let i = 0; i < maxLength; i++) {
			const oriNum = parseInt(ori[i] || "0", 10);
			const tarNum = parseInt(tar[i] || "0", 10);

			if (oriNum !== tarNum) {
				diff = oriNum - tarNum;
				break;
			}
		}

		switch (com) {
			case ">":
				return diff > 0;
			case "<":
				return diff < 0;
			case "=":
				return diff === 0;
			case ">=":
				return diff >= 0;
			case "<=":
				return diff <= 0;
			case "!=":
				return diff !== 0;
			default:
				return false;
		}
	}
}

export { VerChecker };