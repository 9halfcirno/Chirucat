import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import type { ActionResponses, BotActions } from "../../src/protocols/actions";
import type { MessageBlock } from "../../src/protocols/message-block";
import type { AccessTokenManager } from "./access";
import { BASE_URL, PLATFORM } from "./config";
import { stringifyContent } from "./utils/content-parser";

/** QQ 消息收发场景: 群聊 / 私聊 */
type SendTarget = {
	type: "group" | "private";
	/** 群OpenID 或 用户OpenID */
	id: string;
};

export class ActionSender {
	/** extra 对象 -> 消息序列号, 用于消息去重 (QQ msg_seq) */
	private msgSeqs = new WeakMap<Record<string, any>, number>();

	constructor(private ctx: AdapterContext, private access: AccessTokenManager) { }

	/**
	 * 统一 Action 分发入口
	 *
	 * 必须为每个动作给出明确响应: 动作已按 meta.adapter 路由到本适配器,
	 * 返回 undefined 会被框架记为"未处理"(ACTION_NOT_HANDLED), 调用方只看到失败而看不到原因。
	 */
	async send<T extends BotActions>(
		action: T,
		extra?: Record<string, any>
	): Promise<ActionResponses[T["type"]]> {
		// 1. 处理消息撤回
		if (action.type === "message.delete") {
			return (await this.handleDelete(action as Extract<BotActions, { type: "message.delete" }>)) as ActionResponses[T["type"]];
		}

		// 2. 仅处理消息发送, 其余动作类型不属于本适配器(框架路由错误)
		if (action.type !== "message.send") {
			// 曾处理过的类型已被收窄为 never, 这里取其运行时真实类型名
			const unsupported: string = (action as BotActions).type;
			this.ctx.logger.error(`收到不支持的Action类型: ${unsupported}`);
			return {
				success: false,
				error: `Unsupported action type: ${unsupported}`,
				code: "UNSUPPORTED_ACTION"
			} as ActionResponses[T["type"]];
		}

		const sendAction = action as Extract<BotActions, { type: "message.send" }>;
		const result = this.ctx.session.query(sendAction.session);

		if (!result) {
			this.ctx.logger.error(`无法解析目标会话: ${sendAction.session}`);
			return {
				success: false,
				error: `Session not found: ${sendAction.session}`,
				code: "SESSION_NOT_FOUND"
			} as ActionResponses[T["type"]];
		}

		const { platform, type, id } = result;
		if (platform !== PLATFORM) {
			// 动作能到达本适配器, 说明会话就该属于本平台; 不匹配是真实错误, 不能静默忽略
			this.ctx.logger.error(
				`会话平台不匹配: 期望 ${PLATFORM}, 实际 ${platform} (会话 ${sendAction.session})`
			);
			return {
				success: false,
				error: `Platform mismatch: expected ${PLATFORM}, got ${platform}`,
				code: "PLATFORM_MISMATCH"
			} as ActionResponses[T["type"]];
		}

		// 频道(channel)暂不支持
		if (type !== "group" && type !== "private") {
			this.ctx.logger.error(`不支持的会话类型: ${type}`);
			return {
				success: false,
				error: `Unsupported session type: ${type}`,
				code: "UNSUPPORTED_SESSION_TYPE"
			} as ActionResponses[T["type"]];
		}

		const target: SendTarget = { type, id };
		const msgRef = sendAction.quote ? { message_reference: { message_id: sendAction.quote } } : {};

		// 纯文本消息发送
		if (typeof sendAction.message === "string") {
			return (await this.sendText(target, sendAction.message, extra, msgRef)) as ActionResponses[T["type"]];
		}

		// 富文本解析与发送
		const texts: Array<Extract<MessageBlock, { type: "text" | "mention" }>> = [];
		const images: string[] = [];
		for (const block of sendAction.message) {
			if (block.type === "text" || block.type === "mention") texts.push(block);
			else if (block.type === "image" && block.url) images.push(block.url);
		}

		const content = stringifyContent(
			texts,
			(uuid) => {
				const info = this.ctx.user.query(uuid);
				return info?.platform === PLATFORM ? info.id : null;
			},
			type === "group"
		);

		let primaryMsgId: string | undefined;

		// 如果包含文本内容，先发送文本
		if (content.trim()) {
			const textRes = await this.sendText(target, content, extra, msgRef);
			if (!textRes.success) return textRes as ActionResponses[T["type"]];
			primaryMsgId = textRes.id;
		}

		// 逐张上传并发送图片
		for (const url of images) {
			const fileInfo = await this.uploadImage(target, url);
			if (!fileInfo) {
				return {
					success: false,
					error: `Failed to upload image: ${url}`
				} as ActionResponses[T["type"]];
			}

			const mediaRes = await this.sendMedia(target, fileInfo, extra, msgRef);
			if (!mediaRes.success) return mediaRes as ActionResponses[T["type"]];
			if (!primaryMsgId) primaryMsgId = mediaRes.id;
		}

		if (primaryMsgId) {
			return {
				success: true,
				id: primaryMsgId
			} as ActionResponses[T["type"]];
		}

		return {
			success: false,
			error: "Empty message body"
		} as ActionResponses[T["type"]];
	}

	/**
	 * 撤回消息处理 (/v2/groups/{id}/messages/{message_id} 或 /v2/users/{id}/messages/{message_id})
	 */
	private async handleDelete(
		action: Extract<BotActions, { type: "message.delete" }>
	): Promise<ActionResponses["message.delete"]> {
		const result = this.ctx.session.query(action.session);
		if (!result || result.platform !== PLATFORM) {
			this.ctx.logger.error(`撤回失败: 会话不存在或平台不匹配 (${action.session})`);
			return {
				success: false,
				error: `Session not found or platform mismatch: ${action.session}`,
				code: "SESSION_NOT_FOUND"
			};
		}

		const { type, id } = result;
		if (type !== "group" && type !== "private") {
			this.ctx.logger.error(`撤回失败: 不支持的会话类型 ${type}`);
			return {
				success: false,
				error: `Unsupported session type for delete: ${type}`,
				code: "UNSUPPORTED_SESSION_TYPE"
			};
		}

		const target: SendTarget = { type, id };
		const path = target.type === "group" ? "groups" : "users";

		return await this.request(target, `${path}/${target.id}/messages/${action.id}`, "DELETE");
	}

	/**
	 * 发送文本消息 (msg_type=2)
	 */
	private async sendText(
		target: SendTarget,
		content: string,
		extra?: Record<string, any>,
		msgRef?: Record<string, any>
	): Promise<ActionResponses["message.send"]> {
		const path = target.type === "group" ? "groups" : "users";
		return await this.request(
			target,
			`${path}/${target.id}/messages`,
			"POST",
			{
				msg_type: 2,
				markdown: { content },
				msg_id: extra?.msg_id,
				msg_seq: this.nextSeq(extra),
				...msgRef
			}
		);
	}

	/**
	 * 发送富媒体消息 (msg_type=7)
	 */
	private async sendMedia(
		target: SendTarget,
		fileInfo: string,
		extra?: Record<string, any>,
		msgRef?: Record<string, any>
	): Promise<ActionResponses["message.send"]> {
		const path = target.type === "group" ? "groups" : "users";
		return await this.request(
			target,
			`${path}/${target.id}/messages`,
			"POST",
			{
				msg_type: 7,
				media: { file_info: fileInfo },
				msg_id: extra?.msg_id,
				msg_seq: this.nextSeq(extra),
				...msgRef
			}
		);
	}

	/**
	 * 上传图片到目标会话, 返回 file_info
	 */
	private async uploadImage(target: SendTarget, url: string): Promise<string | null> {
		const token = await this.access.get();
		if (!token) {
			this.ctx.logger.error("上传图片失败: 无可用 AccessToken");
			return null;
		}

		const path = target.type === "group" ? "groups" : "users";
		try {
			const resp = await fetch(`${BASE_URL}/v2/${path}/${target.id}/files`, {
				method: "POST",
				headers: {
					Authorization: `QQBot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					file_type: 1,
					url,
					srv_send_msg: false
				})
			});

			if (!resp.ok) {
				this.ctx.logger.error(`上传图片失败: ${resp.status} ${await resp.text()}`);
				return null;
			}
			const data = await resp.json();
			if (!data?.file_info) {
				this.ctx.logger.error(`上传图片失败: 响应缺少 file_info ${JSON.stringify(data)}`);
				return null;
			}
			return data.file_info;
		} catch (e: any) {
			this.ctx.logger.error(`上传图片异常: ${e?.message || e}`);
			return null;
		}
	}

	/**
	 * 通用 HTTP 请求 API（支持返回 ActionResponses 结构）
	 */
	private async request(
		target: SendTarget,
		endpointPath: string,
		method: "POST" | "DELETE",
		body?: Record<string, any>
	): Promise<any> {
		const token = await this.access.get();
		if (!token) {
			this.ctx.logger.error("请求 API 失败: 无可用 AccessToken");
			return {
				success: false,
				error: "No available AccessToken"
			};
		}

		try {
			const resp = await fetch(`${BASE_URL}/v2/${endpointPath}`, {
				method,
				headers: {
					Authorization: `QQBot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body)
			});

			if (!resp.ok) {
				const errorText = await resp.text();
				this.ctx.logger.error(`请求 API 失败 [${method} ${endpointPath}]: ${resp.status} ${errorText}`);
				return {
					success: false,
					error: `QQ API Error (${resp.status}): ${errorText}`
				};
			}

			// DELETE 请求可能无返回 body 或为空
			if (method === "DELETE") {
				return { success: true };
			}

			const data = await resp.json();

			// QQ 发送消息成功会返回带有 id 的 JSON 对象
			if (!data?.id) {
				this.ctx.logger.error(`请求 API 成功但响应缺少 id [${method} ${endpointPath}]: ${JSON.stringify(data)}`);
				return {
					success: false,
					error: `QQ API 响应缺少消息 id: ${JSON.stringify(data)}`
				};
			}

			return {
				success: true,
				id: String(data.id),
				// ext_info 并非所有发送接口都会返回, 缺失时不能把整个响应判成失败
				token: data.ext_info?.ref_idx
			};

		} catch (e: any) {
			const msg = e?.message || String(e);
			this.ctx.logger.error(`请求 API 异常 [${method} ${endpointPath}]: ${msg}`);
			return {
				success: false,
				error: msg
			};
		}
	}

	/**
	 * 取下一条消息序列号
	 */
	private nextSeq(extra?: Record<string, any>): number | undefined {
		if (!extra) return undefined;
		const seq = (this.msgSeqs.get(extra) ?? 0) + 1;
		this.msgSeqs.set(extra, seq);
		return seq;
	}
}