import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import type { BotActions } from "../../src/protocols/actions";
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

	constructor(private ctx: AdapterContext, private access: AccessTokenManager) {

	}
	async send(action: BotActions, extra?: Record<string, any>) {
		if (action.type !== "message.send") return;

		let result = this.ctx.session.query(action.session);
		if (!result) return;
		let { platform, type, id } = result;
		if (platform !== PLATFORM) return;

		// 频道(channel)暂不支持
		if (type !== "group" && type !== "private") return;
		const target: SendTarget = { type, id };

		// 构造消息引用参数
		const msgRef = action.quote ? { message_reference: { message_id: action.quote } } : {};

		// 纯文本消息
		if (typeof action.message === "string") {
			await this.sendText(target, action.message, extra, msgRef);
			return;
		}

		// 富文本: 文本与提及合并为一条文本消息, 图片逐张上传后作为富媒体消息发送
		const texts: Array<Extract<MessageBlock, { type: "text" | "mention" }>> = [];
		const images: string[] = [];
		for (const block of action.message) {
			if (block.type === "text" || block.type === "mention") texts.push(block);
			else if (block.type === "image" && block.url) images.push(block.url);
		}

		const content = stringifyContent(
			texts,
			(uuid) => {
				const info = this.ctx.user.query(uuid);
				return info?.platform === PLATFORM ? info.id : null;
			},
			// @能力仅群聊可用
			type === "group"
		);
		if (content.trim()) await this.sendText(target, content, extra, msgRef);

		for (const url of images) {
			const fileInfo = await this.uploadImage(target, url);
			if (fileInfo) await this.sendMedia(target, fileInfo, extra, msgRef);
		}
	}

	/**
	 * 发送文本消息 (msg_type=2)
	 */
	private async sendText(
		target: SendTarget,
		content: string,
		extra?: Record<string, any>,
		msgRef?: Record<string, any>
	) {
		await this.request(target, "messages", {
			msg_type: 2,
			markdown: { content },
			msg_id: extra?.msg_id,
			msg_seq: this.nextSeq(extra),
			...msgRef
		});
	}

	/**
	 * 发送富媒体消息 (msg_type=7)
	 */
	private async sendMedia(
		target: SendTarget,
		fileInfo: string,
		extra?: Record<string, any>,
		msgRef?: Record<string, any>
	) {
		await this.request(target, "messages", {
			msg_type: 7,
			media: { file_info: fileInfo },
			msg_id: extra?.msg_id,
			msg_seq: this.nextSeq(extra),
			...msgRef
		});
	}

	/**
	 * 上传图片到目标会话, 返回 file_info
	 * 参考: /v2/groups/{group_openid}/files 与 /v2/users/{user_openid}/files
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
	 * 请求发送消息接口
	 */
	private async request(target: SendTarget, endpoint: string, body: Record<string, any>) {
		const token = await this.access.get();
		if (!token) {
			this.ctx.logger.error("发送消息失败: 无可用 AccessToken");
			return;
		}

		const path = target.type === "group" ? "groups" : "users";
		try {
			const resp = await fetch(`${BASE_URL}/v2/${path}/${target.id}/${endpoint}`, {
				method: "POST",
				headers: {
					Authorization: `QQBot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body)
			});
			if (!resp.ok) {
				this.ctx.logger.error(`发送消息失败: ${resp.status} ${await resp.text()}`);
			}
		} catch (e: any) {
			this.ctx.logger.error(`发送消息异常: ${e?.message || e}`);
		}
	}

	/**
	 * 取下一条消息序列号, 被动回复同一个 msg_id 需要递增 msg_seq
	 * 无 extra(主动消息)时不带 msg_seq
	 */
	private nextSeq(extra?: Record<string, any>): number | undefined {
		if (!extra) return undefined;
		const seq = (this.msgSeqs.get(extra) ?? 0) + 1;
		this.msgSeqs.set(extra, seq);
		return seq;
	}
}