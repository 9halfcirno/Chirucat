import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import type { ActionResponses, BotActions } from "../../src/protocols/actions";
import type Logger from "../../src/utils/logger";
import type { QQApi } from "./api";
import { splitSendBlocks, stringifyContent } from "./codec";
import { MSG_TYPE_MEDIA, MSG_TYPE_TEXT, PLATFORM } from "./config";
import type { QQSendTarget } from "./types";
import type { MediaUploader } from "./uploader";

/**
 * Bot 动作 -> QQ 接口
 *
 * 动作类型到处理器的映射集中在 {@link QQ_ACTIONS}: 它被声明为 {@link QQActionHandlers},
 * 因此框架新增一个 Action 类型时, 这里会因为"少一个键"而编译失败 —— 不会出现
 * 新增动作无人处理、调用方只拿到 ACTION_NOT_HANDLED 的情况。
 */

/** 动作处理器依赖 */
export interface QQActionDeps {
	ctx: AdapterContext;
	api: QQApi;
	uploader: MediaUploader;
	logger: Logger;
	/** 被动回复的 msg_seq 分配器 */
	seq: SeqAllocator;
	/** 会话级发送限速门 */
	gate: SessionSendGate;
}

/** 源事件的 extra(框架随动作回传的适配器私有数据, 如 msg_id) */
export type ActionExtra = Record<string, any> | undefined;

/** 单个动作类型的处理器签名 */
export type QQActionHandler<K extends BotActions["type"]> = (
	action: Extract<BotActions, { type: K }>,
	extra: ActionExtra,
	deps: QQActionDeps
) => Promise<ActionResponses[K]>;

/** 全部动作的实现表(键必须覆盖 BotActions 的所有 type) */
export type QQActionHandlers = {
	[K in BotActions["type"]]: QQActionHandler<K>;
};

/**
 * 被动回复的 msg_seq 分配器
 *
 * QQ 要求同一个被动回复窗口(同一 msg_id)内的多条消息携带互不相同的 msg_seq,
 * 否则后续消息会被平台丢弃。这里按源事件的 `extra` 对象计数 —— 同一个事件产生的
 * 多次回复共享同一个 extra, seq 便能持续递增。
 */
export class SeqAllocator {
	private counters = new WeakMap<Record<string, any>, number>();

	/** 取下一个序号; 无 extra(非被动回复)时返回 undefined */
	next(extra: ActionExtra): number | undefined {
		if (!extra) return undefined;
		const seq = (this.counters.get(extra) ?? 0) + 1;
		this.counters.set(extra, seq);
		return seq;
	}
}

/**
 * 会话级发送限速门
 *
 * 每个 session 维护一条 Promise 链, 保证并发发送按序排队;
 * 每次实际发送前检查距上次发送的间隔, 不足则 sleep 补齐。
 * 首条消息不等待(lastSend 初始为 0, 与当前时间差远大于任何合理 interval)。
 */
export class SessionSendGate {
	private lastSend = new Map<string, number>();
	private chains = new Map<string, Promise<void>>();

	async wait(session: string, intervalMs: number): Promise<void> {
		const prev = this.chains.get(session) ?? Promise.resolve();
		const next = prev.then(() => this.doWait(session, intervalMs));
		this.chains.set(session, next);
		return next;
	}

	private async doWait(session: string, intervalMs: number): Promise<void> {
		if (intervalMs > 0) {
			const elapsed = Date.now() - (this.lastSend.get(session) ?? 0);
			const remaining = intervalMs - elapsed;
			if (remaining > 0) await new Promise<void>(r => setTimeout(r, remaining));
		}
		this.lastSend.set(session, Date.now());
	}
}

/** 目标会话解析结果 */
type TargetResult =
	| { ok: true; target: QQSendTarget }
	| { ok: false; error: string; code: string };

/**
 * 把框架会话 uuid 解析为 QQ 发送目标
 *
 * 平台不匹配、会话类型不支持都返回失败而不是静默忽略: 动作既然已被框架路由到
 * 本适配器, "不归我管" 就不是合法状态, 静默会让问题伪装成 ACTION_NOT_HANDLED。
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

	// 频道(channel)暂不支持
	if (info.type !== "group" && info.type !== "private") {
		return {
			ok: false,
			error: `Unsupported session type: ${info.type}`,
			code: "UNSUPPORTED_SESSION_TYPE"
		};
	}

	return { ok: true, target: { type: info.type, id: info.id } };
}

/** 组装发送成功响应(token 可选, 缺失时不能写入 undefined) */
function sendSuccess(id: string, token?: string): ActionResponses["message.send"] {
	const result: { success: true; id: string; token?: string } = { success: true, id };
	if (token) result.token = token;
	return result;
}

/** 取错误文本 */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** 发送一条文本(markdown)消息, msg_type=2 */
async function sendText(
	deps: QQActionDeps,
	target: QQSendTarget,
	content: string,
	extra: ActionExtra,
	msgRef: Record<string, any>
): Promise<ActionResponses["message.send"]> {
	try {
		const res = await deps.api.sendMessage(target, {
			msg_type: MSG_TYPE_TEXT,
			markdown: { content },
			// 被动回复: 带上源事件的 msg_id, 否则会占用主动消息频次
			msg_id: extra?.msg_id,
			msg_seq: deps.seq.next(extra),
			...msgRef
		});
		return sendSuccess(res.id, res.token);
	} catch (e) {
		const msg = errorMessage(e);
		deps.logger.error(`发送文本消息失败: ${msg}`);
		return { success: false, error: msg };
	}
}

/** 发送一条富媒体消息, msg_type=7 */
async function sendMedia(
	deps: QQActionDeps,
	target: QQSendTarget,
	fileInfo: string,
	extra: ActionExtra,
	msgRef: Record<string, any>
): Promise<ActionResponses["message.send"]> {
	try {
		const res = await deps.api.sendMessage(target, {
			msg_type: MSG_TYPE_MEDIA,
			media: { file_info: fileInfo },
			msg_id: extra?.msg_id,
			msg_seq: deps.seq.next(extra),
			...msgRef
		});
		return sendSuccess(res.id, res.token);
	} catch (e) {
		const msg = errorMessage(e);
		deps.logger.error(`发送富媒体消息失败: ${msg}`);
		return { success: false, error: msg };
	}
}

/**
 * message.send
 *
 * 字符串内容直接发送; 消息块数组拆成"文本 + 媒体"两部分 ——
 * QQ 一次请求只能带一个 media.file_info, 所以媒体需要逐条上传并发送。
 */
const handleMessageSend: QQActionHandler<"message.send"> = async (action, extra, deps) => {
	const resolved = resolveTarget(deps.ctx, action.session);
	if (!resolved.ok) {
		deps.logger.error(`发送消息失败: ${resolved.error}`);
		return { success: false, error: resolved.error, code: resolved.code };
	}

	const interval = deps.ctx.config.get<number>("reply_interval", 0);
	await deps.gate.wait(action.session, interval);

	const { target } = resolved;
	// 引用消息: QQ 用 message_reference.message_id 承载
	const msgRef = action.quote ? { message_reference: { message_id: action.quote } } : {};

	if (typeof action.message === "string") {
		return await sendText(deps, target, action.message, extra, msgRef);
	}

	const { texts, media } = splitSendBlocks(action.message);

	// 提及段要换成平台 openid; 仅群聊支持 @
	const content = stringifyContent(
		texts,
		(uuid) => {
			const info = deps.ctx.user.query(uuid);
			return info?.platform === PLATFORM ? info.id : null;
		},
		target.type === "group"
	);

	// 首条成功发送的消息 id 作为本次动作的返回值(后续撤回/引用以其为准)
	let primaryId: string | undefined;

	if (content.trim()) {
		const result = await sendText(deps, target, content, extra, msgRef);
		if (!result.success) return result;
		primaryId = result.id;
	}

	for (const item of media) {
		let fileInfo: string;
		try {
			fileInfo = await deps.uploader.upload(target, item.source, item.fileType);
		} catch (e) {
			const msg = errorMessage(e);
			deps.logger.error(`上传 ${item.type} 失败: ${msg}`);
			return { success: false, error: `Failed to upload ${item.type}: ${msg}` };
		}

		const result = await sendMedia(deps, target, fileInfo, extra, msgRef);
		if (!result.success) return result;
		primaryId ??= result.id;
	}

	if (primaryId) return sendSuccess(primaryId);

	return { success: false, error: "Empty message body" };
};

/** message.delete */
const handleMessageDelete: QQActionHandler<"message.delete"> = async (action, _extra, deps) => {
	const resolved = resolveTarget(deps.ctx, action.session);
	if (!resolved.ok) {
		deps.logger.error(`撤回消息失败: ${resolved.error}`);
		return { success: false, error: resolved.error, code: resolved.code };
	}

	try {
		await deps.api.deleteMessage(resolved.target, action.id);
		return { success: true };
	} catch (e) {
		const msg = errorMessage(e);
		deps.logger.error(`撤回消息失败: ${msg}`);
		return { success: false, error: msg };
	}
};

/** 全部动作实现 */
export const QQ_ACTIONS: QQActionHandlers = {
	"message.send": handleMessageSend,
	"message.delete": handleMessageDelete
};

/**
 * 动作分发器
 *
 * 契约: 一定返回响应对象。未知类型与处理器抛出的异常都在这里转成失败响应,
 * 否则 msg.reply() 会以未捕获异常收场, 比 success:false 更难定位。
 */
export class ActionRouter {
	private handlers = new Map<BotActions["type"], QQActionHandler<BotActions["type"]>>();

	constructor(private readonly logger: Logger) { }

	/** 注册处理器; 同一类型后注册的覆盖先注册的 */
	register<K extends BotActions["type"]>(type: K, handler: QQActionHandler<K>): this {
		this.handlers.set(type, handler as unknown as QQActionHandler<BotActions["type"]>);
		return this;
	}

	/** 分发一个动作, 总是返回响应对象 */
	async dispatch<T extends BotActions>(
		action: T,
		extra: ActionExtra,
		deps: QQActionDeps
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

/** 注册 QQ 适配器的全部动作处理器 */
export function registerQQActions(router: ActionRouter): ActionRouter {
	router.register("message.send", QQ_ACTIONS["message.send"]);
	router.register("message.delete", QQ_ACTIONS["message.delete"]);
	return router;
}
