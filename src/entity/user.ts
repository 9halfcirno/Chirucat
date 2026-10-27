export interface User {
	/** 用户框架id */
	id: string;

	/** 用户昵称, 适配器无法提供时为空字符串 */
	name: string;

	/** 用户的内部组id, 用于跨平台识别同一用户 */
	unionId: string | null;

	/** 用户权限等级, 数值越高等级越高 */
	permission: number;
}