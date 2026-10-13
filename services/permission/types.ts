/** 权限等级 (写入 msg.sender.permission, 文档尚未收录的 number 字段) */
export const PermissionLevel = {
	/** 普通用户 */
	User: 0,
	/** 管理员, 由配置项 `admins` 指定 */
	Admin: 1,
	/** 框架持有者, 由配置项 `master` 指定 */
	Master: 3,
} as const;

export type PermissionLevelValue = (typeof PermissionLevel)[keyof typeof PermissionLevel];

/** `admins` 表格的一行 */
export interface AdminEntry {
	/** 管理员的跨平台用户 uuid */
	unionId?: string;
}