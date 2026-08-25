export class ValidationError extends Error {
	constructor(message: string, key: string, file: string) {
		super(`${message} 文件${file}缺少"${key}"字段`);
	}
}