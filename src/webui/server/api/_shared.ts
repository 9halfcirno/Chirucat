import type { Core } from "../../../core";
import type { Bot } from "../../../bot/bot";
import type { ConfigManager, ConfigValues } from "../../../config/manager";
import type { UserManager } from "../../../internal/user-manager";
import { SettingsApplyError } from "../../../config/settings/manager";
import { SettingsError } from "../../../config/settings/types";

/**
 * api 模块的公共工具
 *
 * 各端点原本各自重复写着同一批样板: core 守卫、Bot 查找、`{ err, code }`
 * 字面量、平台账号参数校验……写法与字段顺序渐渐漂移(有的漏带 code, 有的
 * 抛 409 却表示"不存在")。这里集中维护一份, 端点只描述"要什么"。
 */

/**
 * handler 抛出的 API 错误对象
 *
 * 与 `server.ts` 的 `APIError` 同构 —— 服务器侧靠 `isAPIError` 识别它, 把
 * `code` 当 HTTP 状态码回给前端。api 模块共用这一份, 不再各写字面量。
 */
export interface APIError {
	err: string;
	code: number;
	details?: unknown;
}

/**
 * 抛出一条 API 错误, 中止当前 handler
 *
 * `code` 作为 HTTP 状态码返回给前端; 服务器侧会把超出 400-599 的值兜成 500,
 * 但调用方应当自己给对(404 表示不存在、409 表示冲突、503 表示暂时不可用)。
 */
export function fail(code: number, err: string, details?: unknown): never {
	const error: APIError = { code, err };
	if (details !== undefined) error.details = details;
	throw error;
}

/** Core 未连接时抛 503 —— 独立启动的 WebUI 没有核心, 依赖核心的端点都先过这一关 */
export function requireCore(core: Core | undefined): Core {
	if (core) return core;
	fail(503, "WebUI未连接到核心");
}

/** 用户模块未就绪时抛 503 —— 它在 Core.init 早期就建立, 只有核心正在关闭时才可能为空 */
export function requireUser(core: Core): UserManager {
	if (core.user) return core.user;
	fail(503, "核心用户模块未就绪");
}

/** 取目标 Bot, 不存在抛 404 */
export function requireBot(core: Core, id: string): Bot {
	const bot = core.bot.bots.get(id);
	if (bot) return bot;
	fail(404, id ? `目标Bot不存在: ${id}` : "目标Bot不存在");
}

/** 取目标 Bot 并要求它正在运行, 未启动抛 503(插件启停等操作依赖运行态) */
export function requireRunningBot(core: Core, id: string): Bot {
	const bot = requireBot(core, id);
	if (bot.running) return bot;
	fail(503, id ? `目标Bot未启动: ${id}` : "目标Bot未启动");
}

/**
 * 校验并取出一个 `{ platform, id }` 目标, 两者都必须是非空字符串
 *
 * `field` 给嵌套场景(如 `bind_account` 的 source/target)用, 错误信息会带上字段名。
 */
export function parseTarget(value: unknown, field?: string): { platform: string; id: string } {
	const { platform, id } = (value ?? {}) as { platform?: unknown; id?: unknown };
	const prefix = field ? `${field}.` : "";
	if (typeof platform !== "string" || !platform.trim()) {
		fail(400, `${prefix}platform 必须是非空字符串`);
	}
	if (typeof id !== "string" || !id.trim()) {
		fail(400, `${prefix}id 必须是非空字符串`);
	}
	return { platform: platform.trim(), id: id.trim() };
}

/**
 * 校验并保存一份插件/服务插件配置
 *
 * 两种 `ConfigManager` 结构完全一致, 只是取实例的途径不同(Bot 插件先扫描、
 * 服务插件按需装配), 校验与落盘的流程共用这里。校验不通过不落盘, `details`
 * 带字段级错误供前端定位到具体控件。
 *
 * @param config 目标的配置管理器
 * @param patch 提交值(前端 config-editor 的 getValues() 输出)
 * @param label 错误信息里的名称, 形如 "插件 xxx" / "服务插件 xxx"
 */
export async function savePluginConfig(
	config: ConfigManager,
	patch: unknown,
	label: string,
): Promise<{ success: true; config: ConfigValues }> {
	const errors = config.vaildate(patch);
	if (errors.length) {
		const detail = errors
			.map(e => `${e.path || "配置"}: ${e.message}`)
			.join("; ");
		fail(400, `${label} 的配置校验未通过: ${detail}`, errors);
	}

	try {
		await config.update(patch);
	} catch (e) {
		fail(500, `保存 ${label} 的配置失败: ${(e as Error).message}`);
	}

	// 回传规范化后的值: 隐藏项、缺失键已被补齐, 便于前端与后端对齐
	return { success: true, config: config.data };
}

/**
 * 把设置域的 patch 错误翻译成 API 错误
 *
 * - `SettingsError`: 校验没过, 值没落盘 → 400, details 带字段级错误
 * - `SettingsApplyError`: 值已落盘但热应用失败 → 500, 报"存住了但没生效",
 *   而不是笼统的保存失败(前端据此提示用户重启)
 * - 其余未知错误: 一并 500
 *
 * update_bot_config / update_settings 共用这一段。
 *
 * @param e patch 抛出的错误
 * @param label 错误信息里的动作名, 形如 "保存设置" / "保存Bot设置"
 */
export function rethrowSettingsError(e: unknown, label: string): never {
	if (e instanceof SettingsError) {
		fail(400, e.message, e.details);
	}
	if (e instanceof SettingsApplyError) {
		fail(
			500,
			e.message,
			{ values: e.outcome.values, changed: e.outcome.changed },
		);
	}
	fail(500, `${label}失败: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * 取整数并夹在 [min, max] 内; 非数字时用默认值
 *
 * 分页参数等"客户端给的数字不可信"场景共用(list_users / get_user_overview)。
 */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
}
