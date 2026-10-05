import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import type { ActionResponses, BotActions } from "../../src/protocols/actions";
import type { SessionType } from "../../src/protocols/session";
import type Logger from "../../src/utils/logger";
import { blocksToSegments, type Ob11CodecDeps, type SendableBlock } from "./codec";
import { PLATFORM } from "./constants";
import type { Ob11Connection } from "./connection";
import type { OneBotSegment } from "./types";

/**
 * Bot 动作 -> OneBot API
 *
 * 动作类型到处理器的映射集中在 {@link OB11_ACTIONS}: 它被声明为 {@link Ob11ActionHandlers},
 * 因此框架新增 Action 类型时这里会因"少一个键"而编译失败, 不会出现动作无人处理、
 * 调用方只拿到 ACTION_NOT_HANDLED 的情况。
 */

/** 动作处理器依赖 */
export interface Ob11ActionDeps {
	ctx: AdapterContext;
	connection: Ob11Connection;
	codec: Ob11CodecDeps;
	logger: Logger;
}

/** 源事件的 extra */
export type ActionExtra = Record<string, any> | undefined;

/** 单个动作类型的处理器签名 */
export type Ob11ActionHandler<K extends BotActions["type"]> = (
	action: Extract<BotActions, { type: K }>,
	extra: ActionExtra,
	deps: Ob11ActionDeps
) => Promise<ActionResponses[K]>;

/** 全部动作的实现表(键必须覆盖 BotActions 的所有 type) */
export type Ob11ActionHandlers = {
	[K in BotActions["type"]]: Ob11ActionHandler<K>;
};

/** 发送目标: 已解析并校验过的会话 */
interface SendTarget {
	type: "group" | "private";
	/** 平台会话 id */
	id: string;
	/** 数字形式的平台会话 id */
	numericId: number;
}

type TargetResult =
	| { ok: true; target: SendTarget }
	| { ok: false; error: string; code: string };

/** 取错误文本 */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * 把字符串 id 转成 OneBot 期望的数字 id
 * @returns 无法解析时返回 null
 */
function numericId(id: string): number | null {
	const value = Number(id);
	return Number.isFinite(value) ? value : null;
}

/** 收窄可发送的会话类型(OneBot11 没有频道概念) */
function isSendableSessionType(type: SessionType): type is "group" | "private" {
	return type === "group" || type === "private";
}

/**
 * 把框架会话 uuid 解析为发送目标
 *
 * 平台不匹配、会话类型不支持都返回失败而不是静默忽略: 动作已被框架路由到本适配器,
 * "不归我管" 不是合法状态, 静默会让问题伪装成 ACTION_NOT_HANDLED。
 *
 * 撤回动作其实不需要会话 id, 但仍做同样校验 —— 保持"路由到本适配器的动作必须属于
 * 本平台"这一不变量, 否则平台串号会悄无声息地成功。
 */
function resolveTarget(ctx: AdapterContext, session: string): TargetResult {
	const info = ctx.session.query(session);

	if (!info) {
		return { ok: false, error: `Session not found: ${session}`, code: "SESSION_NOT_FOUND" };
	}

	if (info.platform !== PLATFORM) {
		return {
			ok: false,
			error: `Platform mismatch: expected ${PLATFORM}, got ${info.platform}`,
			code: "PLATFORM_MISMATCH"
		};
	}

	// 频道(channel)在 OneBot11 里没有对应概念
	if (!isSendableSessionType(info.type)) {
		return {
			ok: false,
			error: `Unsupported session type: ${info.type}`,
			code: "UNSUPPORTED_SESSION_TYPE"
		};
	}

	const numeric = numericId(info.id);
	if (numeric === null) {
		return {
			ok: false,
			error: `Invalid numeric session id: ${info.id}`,
			code: "INVALID_SESSION_ID"
		};
	}

	return { ok: true, target: { type: info.type, id: info.id, numericId: numeric } };
}

/**
 * 把发送回包转成响应
 *
 * 调用成功但缺少 message_id 时报失败: 后续撤回/引用都要用这个 id,
 * 空 id 会把错误推到更远的地方。
 */
function sendResult(res: any, logger: Logger): ActionResponses["message.send"] {
	const messageId = res?.message_id;

	if (messageId === undefined || messageId === null) {
		const detail = JSON.stringify(res);
		logger.error(`发送调用成功但响应缺少 message_id: ${detail}`);
		return { success: false, error: `OneBot API 响应缺少 message_id: ${detail}` };
	}

	return { success: true, id: String(messageId) };
}

/** message.send */
const handleMessageSend: Ob11ActionHandler<"message.send"> = async (action, _extra, deps) => {
	const resolved = resolveTarget(deps.ctx, action.session);
	if (!resolved.ok) {
		deps.logger.error(`发送消息失败: ${resolved.error}`);
		return { success: false, error: resolved.error, code: resolved.code };
	}

	const { target } = resolved;

	// 字符串内容直接当消息体; 消息块则渲染成段数组
	let message: string | OneBotSegment[] = typeof action.message === "string"
		? action.message
		: blocksToSegments(action.message as SendableBlock[], deps.codec);

	// 全部消息块都无法渲染时不要白发一条空消息
	if (Array.isArray(message) && message.length === 0) {
		return { success: false, error: "Empty message body" };
	}

	// 引用消息: OneBot 用 reply 段承载, 且必须排在消息体最前面
	if (action.quote) {
		const reply: OneBotSegment = { type: "reply", data: { id: action.quote } };
		message = Array.isArray(message)
			? [reply, ...message]
			: [reply, { type: "text", data: { text: message } }];
	}

	try {
		const params = target.type === "group"
			? { group_id: target.numericId, message }
			: { user_id: target.numericId, message };

		const actionName = target.type === "group" ? "send_group_msg" : "send_private_msg";
		const res = await deps.connection.callApi(actionName, params);
		return sendResult(res, deps.logger);
	} catch (e) {
		const msg = errorMessage(e);
		deps.logger.error(`发送消息失败: ${msg}`);
		return { success: false, error: msg };
	}
};

/** message.delete */
const handleMessageDelete: Ob11ActionHandler<"message.delete"> = async (action, _extra, deps) => {
	const resolved = resolveTarget(deps.ctx, action.session);
	if (!resolved.ok) {
		deps.logger.error(`撤回消息失败: ${resolved.error}`);
		return { success: false, error: resolved.error, code: resolved.code };
	}

	try {
		// 平台侧 message_id 是数字, 能转就转回数字形态
		const id = numericId(action.id) ?? action.id;
		await deps.connection.callApi("delete_msg", { message_id: id });
		return { success: true };
	} catch (e) {
		const msg = errorMessage(e);
		deps.logger.error(`撤回消息失败: ${msg}`);
		return { success: false, error: msg };
	}
};

/** 全部动作实现 */
export const OB11_ACTIONS: Ob11ActionHandlers = {
	"message.send": handleMessageSend,
	"message.delete": handleMessageDelete
};

/**
 * 动作分发器
 *
 * 契约: 一定返回响应对象。未知类型与处理器抛出的异常都在这里转成失败响应。
 */
export class ActionRouter {
	private handlers = new Map<BotActions["type"], Ob11ActionHandler<BotActions["type"]>>();

	constructor(private readonly logger: Logger) { }

	/** 注册处理器; 同一类型后注册的覆盖先注册的 */
	register<K extends BotActions["type"]>(type: K, handler: Ob11ActionHandler<K>): this {
		this.handlers.set(type, handler as unknown as Ob11ActionHandler<BotActions["type"]>);
		return this;
	}

	/** 分发一个动作, 总是返回响应对象 */
	async dispatch<T extends BotActions>(
		action: T,
		extra: ActionExtra,
		deps: Ob11ActionDeps
	): Promise<ActionResponses[T["type"]]> {
		const handler = this.handlers.get(action.type);

		if (!handler) {
			this.logger.error(`收到不支持的Action类型: ${action.type}`);
			return {
				success: false,
				error: `Unsupported action type: ${action.type}`,
				code: "UNSUPPORTED_ACTION"
			} as ActionResponses[T["type"]];
		}

		try {
			return await handler(action, extra, deps) as ActionResponses[T["type"]];
		} catch (e) {
			const msg = errorMessage(e);
			this.logger.error(`处理Action ${action.type} 时异常: ${msg}`);
			return {
				success: false,
				error: msg,
				code: "ADAPTER_ERROR"
			} as ActionResponses[T["type"]];
		}
	}
}

/** 注册 OneBot11 适配器的全部动作处理器 */
export function registerOb11Actions(router: ActionRouter): ActionRouter {
	router.register("message.send", OB11_ACTIONS["message.send"]);
	router.register("message.delete", OB11_ACTIONS["message.delete"]);
	return router;
}
