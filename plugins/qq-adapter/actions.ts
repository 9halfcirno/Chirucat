import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import type { ActionResponses, BotActions } from "../../src/protocols/actions";
import type { ActionErrorCode } from "../../src/protocols/errors";
import type { MessageBlockSend } from "../../src/protocols/message-block";
import type Logger from "../../src/utils/logger";
import type { QQApi } from "./api";
import { splitSendBlocks, stringifyContent } from "./codec";
import type { ImageMaterialCache } from "./image-cache";
import { MSG_TYPE_MEDIA, MSG_TYPE_TEXT, PLATFORM, QQ_FILE_TYPE } from "./config";
import { getImageSize, imageScaleFromBytes } from "./img-size";
import { resolveFileName, toBuffer } from "./media";
import type { PassiveReplyWindow } from "./passive-window";
import type { MixedSegment } from "./send-router";
import { isHttpUrl, planSend, renderMixedSegments } from "./send-router";
import type { QQSendTarget } from "./types";
import type { MediaUploader } from "./uploader";

/**
 * Bot 动作 -> QQ 接口
 *
 * 动作类型到处理器的映射集中在 {@link QQ_ACTIONS}: 它被声明为 {@link QQActionHandlers},
 * 因此框架新增一个 Action 类型时, 这里会因为"少一个键"而编译失败 —— 不会出现
 * 新增动作无人处理、调用方只拿到 ADAPTER_UNHANDLED 的情况。
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
	/** 被动回复窗口: 决定本次发送带不带 msg_id */
	msgWindow: PassiveReplyWindow;
	/** 图片素材缓存: 图文混合消息的 markdown 内嵌走这条通道 */
	imageCache: ImageMaterialCache;
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
	| { ok: false; error: string; code: ActionErrorCode };

/**
 * 把框架会话 uuid 解析为 QQ 发送目标
 *
 * 平台不匹配、会话类型不支持都返回失败而不是静默忽略: 动作既然已被框架路由到
 * 本适配器, "不归我管" 就不是合法状态, 静默会让问题伪装成 ADAPTER_UNHANDLED。
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
			code: "UNKNOWN_PLATFORM"
		};
	}

	// 频道(channel)暂不支持
	if (info.type !== "group" && info.type !== "private") {
		return {
			ok: false,
			error: `Unsupported session type: ${info.type}`,
			code: "PARAMS_INVALID"
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

/** 同一 msg_id 允许的被动回复条数, 超出后平台不再接受, 只能退回主动消息 */
const PASSIVE_SEQ_LIMIT = 5;

/**
 * 构造被动回复字段
 *
 * 源消息仍在窗口内才带 `msg_id`(被动回复, 不占主动消息限额);
 * 过期、没有 msg_id 或序号已超过 {@link PASSIVE_SEQ_LIMIT} 时返回空对象 ——
 * 不带 msg_id 的请求就是主动消息。
 * `msg_seq` 仅在真正被动回复时分配: 同一 msg_id 的多条回复需要互不相同的序号。
 */
function passiveRef(deps: QQActionDeps, extra: ActionExtra): Record<string, any> {
	const msgId = deps.msgWindow.pick(extra);
	if (!msgId) return {};
	const seq = deps.seq.next(extra);
	if (seq === undefined || seq > PASSIVE_SEQ_LIMIT) return {};
	return { msg_id: msgId, msg_seq: seq };
}

/**
 * 主动消息失败的补充说明
 *
 * `40034100`(超出频控) / `40034105`(无权限) 是主动消息独有的错误码,
 * 直接看平台原文不容易联想到"被动窗口已过期"这个前提, 这里补一句。
 */
function explainSendError(msg: string, passive: boolean): string {
	if (passive) return msg;
	if (msg.includes("40034100")) return `${msg} (主动消息发送超过频控限额, 请降低频率或等待配额恢复)`;
	if (msg.includes("40034105")) return `${msg} (主动消息发送失败, 无权限, 请检查机器人权限设置)`;
	return msg;
}

/** 发送一条文本(markdown)消息, msg_type=2 */
async function sendText(
	deps: QQActionDeps,
	target: QQSendTarget,
	content: string,
	extra: ActionExtra,
	msgRef: Record<string, any>
): Promise<ActionResponses["message.send"]> {
	// 被动回复: 带上源事件的 msg_id, 否则会占用主动消息限额
	const ref = passiveRef(deps, extra);
	// markdown 链接语法在行首会吞掉紧随的括号, 所有 msg_type=2 发送统一收口转义
	const safeContent = content.startsWith("[") ? `\\${content}` : content;
	try {
		const res = await deps.api.sendMessage(target, {
			msg_type: MSG_TYPE_TEXT,
			markdown: { content: safeContent },
			...ref,
			...msgRef
		});
		return sendSuccess(res.id, res.token);
	} catch (e) {
		const msg = explainSendError(errorMessage(e), ref.msg_id !== undefined);
		deps.logger.error(`发送文本消息失败: ${msg}`);
		return { success: false, code: "UNKNOWN_ERROR", error: msg };
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
	const ref = passiveRef(deps, extra);
	try {
		const res = await deps.api.sendMessage(target, {
			msg_type: MSG_TYPE_MEDIA,
			media: { file_info: fileInfo },
			...ref,
			...msgRef
		});
		return sendSuccess(res.id, res.token);
	} catch (e) {
		const msg = explainSendError(errorMessage(e), ref.msg_id !== undefined);
		deps.logger.error(`发送富媒体消息失败: ${msg}`);
		return { success: false, code: "UNKNOWN_ERROR", error: msg };
	}
}

/**
 * 图文混合走单条 markdown: 按原始消息块顺序渲染(文本/提及/图片各自归位),
 * 不再固定"文前图后"。图片解析:
 * - Buffer 图片经素材缓存换 qqbot-media:// URL(去重、可复用);
 * - http(s) 图片直接外链内嵌, 尺寸用 Range 探测(探测失败按 #0px 自适应)。
 *
 * 返回 null 表示"未发出任何消息、应回退到逐条通道": 素材上传失败、markdown 超长/为空、
 * markdown 发送被拒都在这个前提下, 回退不会产生重复消息。
 */
async function trySendMixedMarkdown(
	deps: QQActionDeps,
	target: QQSendTarget,
	blocks: MessageBlockSend[],
	resolveMention: (uuid: string) => string | null,
	extra: ActionExtra,
	msgRef: Record<string, any>
): Promise<ActionResponses["message.send"] | null> {
	let markdown: string | null;
	try {
		const segments: MixedSegment[] = [];
		for (const block of blocks) {
			if (block.type === "text") {
				segments.push({ kind: "text", value: block.text });
				continue;
			}
			if (block.type === "mention") {
				// 与逐条路径同一个渲染器: 解析不到退化为 @昵称或丢弃, 行为保持一致
				const rendered = stringifyContent([block], resolveMention, true);
				if (rendered) segments.push({ kind: "text", value: rendered });
				continue;
			}
			if (block.type !== "image") continue;
			if (block.buffer) {
				const bytes = toBuffer(block.buffer);
				const name = resolveFileName(bytes, QQ_FILE_TYPE.image);
				const url = await deps.imageCache.getImageUrl({ buffer: bytes, fileName: name });
				segments.push({ kind: "image", url, size: imageScaleFromBytes(bytes) ?? undefined });
			} else if (block.url && isHttpUrl(block.url)) {
				const size = await getImageSize(block.url);
				segments.push({ kind: "image", url: block.url, size: size ?? undefined });
			}
			// 无可用来源的 image 块与 splitSendBlocks 的丢弃行为对齐
		}
		markdown = renderMixedSegments(segments);
	} catch (e) {
		deps.logger.warn(`素材图片上传失败, 图文合并回退为逐条发送: ${errorMessage(e)}`);
		return null;
	}
	if (!markdown) {
		deps.logger.warn("图文 markdown 为空或超出长度上限, 回退为逐条发送");
		return null;
	}

	const result = await sendText(deps, target, markdown, extra, msgRef);
	if (result.success) return result;
	deps.logger.warn("图文 markdown 发送失败, 回退为逐条发送");
	return null;
}

/**
 * message.send
 *
 * 字符串内容直接发送; 消息块数组拆成"文本 + 媒体"两组后交由 planSend 路由:
 * 图文混合合并为一条 markdown, 其余保持"文本一条 + 媒体逐条"(QQ 的 file_info
 * 通道一次请求只能带一个媒体)。markdown 合并失败时回退逐条, 不会重复发送。
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
	const resolveMention = (uuid: string): string | null => {
		const info = deps.ctx.user.query(uuid);
		return info?.platform === PLATFORM ? info.id : null;
	};
	const content = stringifyContent(texts, resolveMention, target.type === "group");

	// 每次发送现读, 保证 config.watch 改完即时生效
	const mergeMixed = deps.ctx.config.get<string>("material.mixed_markdown", "merge") !== "split";
	const plan = planSend(content, media, mergeMixed);

	if (plan.kind === "text") {
		if (!content.trim()) {
			return { success: false, code: "PARAMS_INVALID", error: "Empty message body" };
		}
		return await sendText(deps, target, content, extra, msgRef);
	}

	if (plan.kind === "markdown-mixed") {
		const mixed = await trySendMixedMarkdown(deps, target, action.message, resolveMention, extra, msgRef);
		if (mixed) return mixed;
		// 回退: 继续走下方"先文本后媒体"的逐条路径
	}

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
			return { success: false, code: "PLATFORM_ERROR", error: `Failed to upload ${item.type}: ${msg}` };
		}

		const result = await sendMedia(deps, target, fileInfo, extra, msgRef);
		if (!result.success) return result;
		primaryId ??= result.id;
	}

	if (primaryId) return sendSuccess(primaryId);

	return { success: false, code: "PARAMS_INVALID", error: "Empty message body" };
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
		return { success: false, code: "UNKNOWN_ERROR", error: msg };
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
				code: "ACTION_UNSUPPORTED"
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
