/**
 * Action统一错误码
 * @alpha 当前处于初版设计, 部分错误码可能修改/删减, 目前仅供参考
 */
const ActionErrorCodes = {
	// 适配器侧
	ADAPTER_ERROR: "ADAPTER_ERROR",             // 适配器处理错误, 通常为适配器抛出错误
	ADAPTER_UNHANDLED: "ADAPTER_UNHANDLED",     // 未处理或无响应数据, 正常 理论应返回响应对象

	// 平台侧
	PLATFORM_ERROR: "PLATFORM_ERROR",                         // 平台侧错误, 通常为平台响应以下无法形容的错误
	PLATFORM_PERMISSION_DENIED: "PLATFORM_PERMISSION_DENIED", // 平台侧权限拒绝, 通常是Bot在对应平台的权限不足, 或无法访问对应资源
	PLATFORM_RESPONSE_ERROR: "PLATFORM_RESPONSE_ERROR",       // 平台侧响应数据有问题
	PLATFORM_REACH_LIMIT: "PLATFORM_REACH_LIMIT",             // 平台接口达到速率上限或额度耗尽
	PLATFORM_UNAUTHENTICATED: "PLATFORM_UNAUTHENTICATED",     // 未鉴权, 通常未能成功连接至平台服务, 或账号会话过期(部分第三方Bot服务实现)

	// 适配器 & 平台侧
	ACTION_UNSUPPORTED: "ACTION_UNSUPPORTED",      // 适配器/平台不支持该方法
	PARAMS_UNSUPPORTED: "PARAMS_UNSUPPORTED",      // 平台不接受参数
	REQUEST_ERROR: "REQUEST_ERROR",                // 请求错误, 通常是网络波动导致
	REQUEST_TIMEOUT: "REQUEST_TIMEOUT",            // 请求超时
	SESSION_EXPIRED: "SESSION_EXPIRED",            // 会话过期, 通常为适配器未刷新密钥或平台侧密钥失效

	// 调用方
	PARAMS_INVALID: "PARAMS_INVALID",          // 调用方参数有误
	UNKNOWN_ACTION: "UNKNOWN_ACTION",          // 调用方传入了框架未知的Action
	SESSION_NOT_FOUND: "SESSION_NOT_FOUND",    // 目标会话不存在或已失效

	// 框架侧
	FRAMEWORK_ERROR: "FRAMEWORK_ERROR",      // 框架侧错误, 如处理链路报错等
	ADAPTER_NOT_FOUND: "ADAPTER_NOT_FOUND",  // 适配器未装载, 一般情况是插件异步处理Entity时对应适配器被卸载
	BOT_UNLOADED: "BOT_UNLOADED",            // Bot已经卸载, 一般情况是插件异步处理Entity时Bot被卸载
	CORE_UNLOADED: "CORE_UNLOADED",          // Core已卸载, 通常不会见到该错误
	HOOK_CANCELED: "HOOK_CANCELED",          // Hook钩子处理器取消了该Action

	// 适配器 & 框架侧
	UNKNOWN_PLATFORM: "UNKNOWN_PLATFORM",    // 适配器未知的平台, 当框架错误导致Action路由错适配器时发生(一般不会)

	// 特殊
	UNKNOWN_ERROR: "UNKNOWN_ERROR",          // 未知错误码, 当无法用现有错误码形容错误时
	TODO: "TODO",                            // 该Action处于TODO, 预计即将可用, 框架和适配器均可以返回此
	DEPRECATED: "DEPRECATED",                // Action已废弃且已完全从框架协议移除
} as const

export { ActionErrorCodes }
export type ActionErrorCode = typeof ActionErrorCodes[keyof typeof ActionErrorCodes];