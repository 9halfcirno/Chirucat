export interface BotEvent {
	/** 事件类型 */
	type: unknown;

	/** 事件创建的时间 */
	time: number;

	/** 平台名, 如`qq`, `discord`, `wechat` */
	platform: string;

	/** 扩展对象 */
	extra: Record<string, any>;
}