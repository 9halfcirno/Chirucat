import type { ActionErrorCode } from "../errors";

export type ActionResponse = {
	success: true;
} | {
	/** Action调用失败 */
	success: false;
	/** 失败原因 */
	error: string;
	/** 统一错误码 */
	code: ActionErrorCode;
};
