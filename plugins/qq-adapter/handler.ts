import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";
import type { MessageCreateEvent, MessageQuote } from "../../src/protocols/event/message";
import type { MessageBlock } from "../../src/protocols/message-block";
import type { SessionType } from "../../src/protocols/session";
import { PLATFORM } from "./config";
import { parseContent } from "./utils/content-parser";

export class Handler {
	constructor(private ctx: AdapterContext) { }

	handle(event: Record<string, any>) {
		if (event.op === 11) {
			this.ctx.logger.log(`QQ Adapter: 心跳成功`);
			return;
		}
		const data = event.d;
		if (!data) return;

		// 群聊: 群@机器人与全量群消息
		if (event.t === "GROUP_AT_MESSAGE_CREATE" || event.t === "GROUP_MESSAGE_CREATE") {
			this.dispatch(data, "group", data.group_openid);
			return;
		}

		// 私聊
		if (event.t === "C2C_MESSAGE_CREATE") {
			this.dispatch(data, "private", data.author?.user_openid || data.author?.id);
			return;
		}
	}

	/**
	 * 将平台消息转换为 message.create 事件并派发
	 */
	private dispatch(data: Record<string, any>, sessionType: SessionType, sessionPlatformId: string) {
		// const text: string = (data.content ?? "").trim();
		const raw: string = (data.content ?? "").trim();
		const text = this.stripBotMention(raw, data.mentions ?? []);

		// 被提及用户昵称表, 用于补全提及消息段的 name
		const names = new Map<string, string>();
		for (const user of data.mentions ?? []) {
			const platformId = user?.member_openid || user?.user_openid || user?.id;
			if (platformId) names.set(platformId, user?.username ?? "");
		}

		const richContent: MessageBlock[] = parseContent(text, {
			resolveId: (platformId) => this.ctx.user.get(PLATFORM, platformId),
			names
		});

		// 图片附件追加为图片消息段
		for (const attachment of data.attachments ?? []) {
			const contentType: string = attachment?.content_type ?? "";
			if (!attachment?.url || !contentType.startsWith("image/")) continue;
			richContent.push({ type: "image", url: attachment.url });
		}

		// 空消息(如纯图片且无文本)时兜底一个空文本段
		if (richContent.length === 0) richContent.push({ type: "text", text });

		// 解析引用消息
		const quote = this.resolveQuote(data);

		// 构建 message.create 事件
		const msgCreate: MessageCreateEvent = {
			messageId: data.id,
			senderId: this.ctx.user.get(PLATFORM, data.author.member_openid || data.author.user_openid || data.author.id),
			senderName: data.author.username ?? "",
			sessionId: this.ctx.session.get(PLATFORM, sessionType, sessionPlatformId),
			sessionType,
			text,
			richContent,
			quoteToken: data.message_scene.ext.find((kv: string) => kv.startsWith("msg_idx=")).split("=")[1],
			time: Date.now(),
			source: data,
			type: "message.create",
			extra: {
				msg_id: data.id
			},
			platform: PLATFORM
		};

		// 有引用消息时附加 quote 字段
		if (quote) {
			msgCreate.quote = quote;
		}

		this.ctx.bot.dispatch(msgCreate);
	}

	/**
 * 剥离消息开头 @机器人 的占位符。
 * GROUP_MESSAGE_CREATE 的 content 保留了 <@bot_openid>,
 * 这里统一剥掉开头那一个, 中间的 <@别人> 留给 parseContent。
 */
	private stripBotMention(text: string, mentions: any[]): string {
		const me = mentions.find((m) => m?.is_you === true);
		if (!me) return text;

		const botId = me.id || me.member_openid || me.user_openid;
		if (!botId) return text;

		const prefix = `<@${botId}>`;
		if (text.startsWith(prefix)) {
			return text.slice(prefix.length).trimStart();
		}
		return text;
	}

	/**
	 * 从 msg_elements 解析被引用消息, 构建完整的 msg.create 对象
	 * 仅当 message_type === 103 且 msg_elements 非空时返回对象, 否则返回 undefined
	 */
	private resolveQuote(
		data: Record<string, any>,
	): MessageQuote | undefined {
		if (data.message_type !== 103) return undefined;
		if (!Array.isArray(data.msg_elements) || data.msg_elements.length === 0) return undefined;

		// msg_elements[0] 通常是被引用的原始消息
		const quoted = data.msg_elements[0];
		if (!quoted) return undefined;

		const quotedText: string = (quoted.content ?? "").trim();
		const quotedAuthor = quoted.author || data.author; // 没有就当是这个人说的吧, 毕竟也没法写空

		const quotedRichContent: MessageBlock[] = [{ type: "text", text: quotedText }]; // 只给了content没mentions数组, 用不到parseContent

		// 被引用消息的附件
		for (const attachment of quoted.attachments ?? []) {
			const contentType: string = attachment?.content_type ?? "";
			if (!attachment?.url || !contentType.startsWith("image/")) continue;
			quotedRichContent.push({ type: "image", url: attachment.url });
		}

		// 被引用消息的作者 ID
		const quotedAuthorId = this.ctx.user.get(
			PLATFORM,
			quotedAuthor.member_openid || quotedAuthor.user_openid || quotedAuthor.id
		)

		const quoteMsg: MessageQuote = {
			senderId: quotedAuthorId,
			senderName: quotedAuthor?.username ?? "",
			text: quotedText,
			richContent: quotedRichContent,
		};

		return quoteMsg;
	}
}