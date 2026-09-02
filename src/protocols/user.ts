export interface User {
	/** 用户框架id */
	id: string;

	/** 用户昵称 */
	name: string;

	/** 用户的内部组id, 用于跨平台识别同一用户 */
	unionId: string | null;
}