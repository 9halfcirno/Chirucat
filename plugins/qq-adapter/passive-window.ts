import { TTLMap } from "./ttl-map";
import { PASSIVE_REPLY_WINDOW } from "./config";

/**
 * 解析平台时间戳(RFC3339, 如 `2026-07-21T10:30:00+08:00`)
 *
 * @returns 毫秒时间戳; 字段缺失或格式非法时返回 `undefined`
 */
export function parseMessageTime(timestamp?: string): number | undefined {
	if (!timestamp) return undefined;
	const time = Date.parse(timestamp);
	return Number.isNaN(time) ? undefined : time;
}

/**
 * 被动回复窗口
 *
 * 维护 `msg_id -> message_time` 的 TTL 表: 收到消息时登记, 发送时查询。
 * 仍在窗口内就带 `msg_id` 被动回复(不占主动消息限额), 否则退回主动消息。
 *
 * 窗口起点用平台的发送时间而不是本地收到时间 —— 网关重投/积压时, 二者的差值
 * 恰好就是已经被消耗掉的窗口。TTL 取剩余时间, 因此过期判定与平台一致。
 */
export class PassiveReplyWindow {
	private readonly entries: TTLMap<string, number>;

	constructor(private readonly windowMs: number = PASSIVE_REPLY_WINDOW) {
		this.entries = new TTLMap<string, number>();
	}

	/**
	 * 登记一条消息
	 *
	 * @param msgId 平台消息 id
	 * @param messageTime 消息发送时间(ms), 缺省取当前时间
	 */
	remember(msgId: string, messageTime: number = Date.now()): void {
		// 平台时钟可能快于本地或收到的是补投的老消息: 剩余窗口夹在 [0, windowMs]
		const elapsed = Date.now() - messageTime;
		const remaining = Math.min(this.windowMs, this.windowMs - elapsed);
		if (remaining <= 0) return;

		this.entries.set(msgId, messageTime, remaining);
	}

	/**
	 * 取仍可被动回复的 msg_id
	 *
	 * @param extra 动作回传的事件 extra
	 * @returns 有效 msg_id; 没有 extra、没有 msg_id 或已过期时返回 `undefined`
	 */
	pick(extra: Record<string, any> | undefined): string | undefined {
		const msgId = extra?.msg_id;
		if (typeof msgId !== "string" || !msgId) return undefined;
		return this.entries.has(msgId) ? msgId : undefined;
	}

	/** 销毁内部定时器 */
	destroy(): void {
		this.entries.destroy();
	}
}
