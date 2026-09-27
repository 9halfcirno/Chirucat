export type ActionResponse = {
	success: true;
} | {
	/** Action调用失败 */
	success: false;
	/** 失败原因 */
	message: string;
}