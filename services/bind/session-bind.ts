/**
 * 会话绑定: 把同一物理会话在两个适配器上的会话 UUID 归入同一个 unionId。
 *
 * 与 {@link UserBind} 的区别: 这里绑定的是**会话**(群/频道), 不是账号。
 * 协议本身不区分平台, 两端都只做两件事:
 * - 发起方: 从自己的消息事件里取会话 UUID, 生成一次性 bindId 并等待;
 * - 对端:   从握手消息的事件里取自己的会话 UUID, 用它和 bindId 对应的发起方会话绑定。
 *
 * 框架的 SessionManager 会把两个 UUID 映射到同一个 internal_id, 因此协议层
 * 不需要做任何 groupId / group_openid 的格式转换。
 */

import type { SessionAPI } from "../../src/plugin/services/apis/core";
import { TTLMap } from "./ttl-map";
import { uuid } from "./uuid";

/** 等待握手失败的原因 */
export type SessionBindErrorCode =
	/** TTL 内没有收到对端匹配 */
	| "bind_timeout"
	/** 同一会话发起了更新的一次绑定, 旧请求作废 */
	| "superseded"
	/** 握手消息没有发出去 */
	| "send_failed"
	/** 服务卸载 */
	| "canceled"
	/** 对端会话存在, 但框架绑定动作抛错 */
	| "bind_failed";

/** 以错误形式携带失败原因, 便于 await 侧用 instanceof 取 code */
export class SessionBindError extends Error {
	constructor(readonly code: SessionBindErrorCode) {
		super(code);
		this.name = "SessionBindError";
	}
}

/** 一次对端消费的结果 */
export type SessionBindOutcome =
	| { ok: true; unionId: string }
	| { ok: false; reason: "not_found" | "self" | "peer_missing" | "bind_failed" };

type PendingBind = {
	/** 发起方身份, 由 bot + adapter 组成 */
	owner: string;
	/** 发起方会话 UUID */
	selfSessionId: string;
	/** 发起方会话当时所属的逻辑组 */
	unionId: string;
	resolve: () => void;
	reject: (error: SessionBindError) => void;
	timer: ReturnType<typeof setTimeout> | null;
};

/** bindId 带一个字母前缀: 命令参数解析会把纯数字转成 number, 前缀保证它永远是字符串 */
const BIND_ID_PATTERN = /^b[0-9a-f]{32}$/;

export class SessionBind {
	/** bindId -> 等待中的请求 */
	private readonly pending = new TTLMap<string, PendingBind>();
	/** 发起方(bot + adapter + session) -> 当前 bindId, 用于同一会话的请求去重 */
	private readonly byOwner = new Map<string, string>();

	constructor(private readonly session: SessionAPI) { }

	/**
	 * 发起一次会话绑定
	 *
	 * 同一会话的旧请求会被静默作废, 避免短时间内重复触发时先发出的请求
	 * 在超时后回复一条容易误导用户的失败消息。
	 *
	 * @param owner 发起方身份 (bot + adapter)
	 * @param selfSessionId 发起方会话 UUID
	 * @param ttl 等待对端响应的毫秒数
	 * @returns 一次性 bindId 与等待结果; 超时/作废/发送失败时 reject 为 {@link SessionBindError}
	 * @throws 会话尚未登记时抛出(调用方转为用户可见的失败提示)
	 */
	create(owner: string, selfSessionId: string, ttl: number): { id: string; promise: Promise<void> } {
		this.cancelByOwner(owner, selfSessionId, "superseded");

		const unionId = this.session.getUnion(selfSessionId);
		if (!unionId) throw new Error("会话尚未登记, 无法发起绑定");

		let resolve!: () => void;
		let reject!: (error: SessionBindError) => void;
		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		const id = this.newId();
		const entry: PendingBind = { owner, selfSessionId, unionId, resolve, reject, timer: null };

		// 定时器负责在 TTL 到点时唤醒等待方; TTLMap 的过期只做兜底清理。
		// 不依赖 pending.get(id) 命中: 事件循环阻塞超过 TTL 时 TTLMap 可能已先过期,
		// 但 promise 仍必须被 reject, 否则等待方会永久悬挂。consume/cancel 都会 clear 这个定时器。
		entry.timer = setTimeout(() => {
			entry.timer = null;
			this.remove(id, entry);
			entry.reject(new SessionBindError("bind_timeout"));
		}, ttl);
		this.unref(entry.timer);

		this.pending.set(id, entry, ttl + 1000);
		this.byOwner.set(ownerKey(owner, selfSessionId), id);

		return { id, promise };
	}

	/**
	 * 对端消费 bindId
	 *
	 * @param bindId 握手消息里的 id
	 * @param peerSessionId 对端自己的会话 UUID
	 * @param peerOwner 对端身份 (bot + adapter)
	 */
	consume(bindId: string, peerSessionId: string, peerOwner: string): SessionBindOutcome {
		if (!BIND_ID_PATTERN.test(bindId)) return { ok: false, reason: "not_found" };

		const entry = this.pending.get(bindId);
		if (!entry) return { ok: false, reason: "not_found" };

		// 防御性校验: 发起方自己的适配器回推了这条消息(message_sent), 不消费, 继续等对端
		if (entry.owner === peerOwner) return { ok: false, reason: "self" };

		// 会话必须已由适配器登记; 取不到说明事件与内部库不一致, 不冒险创建空组
		if (!this.session.getUnion(peerSessionId)) return { ok: false, reason: "peer_missing" };

		// 一次性消费: 无论绑定是否成功, 这个 bindId 都不再可用
		this.remove(bindId, entry);

		try {
			// 把对端会话并入发起方所在的逻辑组; 已同组时框架返回 false, 不属于失败
			this.session.bind(entry.unionId, peerSessionId);
		} catch {
			entry.reject(new SessionBindError("bind_failed"));
			return { ok: false, reason: "bind_failed" };
		}

		entry.resolve();
		return { ok: true, unionId: entry.unionId };
	}

	/** 取消一个仍在等待的请求(如握手消息发送失败) */
	cancel(bindId: string, code: SessionBindErrorCode = "canceled"): boolean {
		const entry = this.pending.get(bindId);
		if (!entry) return false;

		this.remove(bindId, entry);
		entry.reject(new SessionBindError(code));
		return true;
	}

	/** 释放全部等待中的请求; 服务卸载时调用, 避免 promise 永久悬挂 */
	dispose(code: SessionBindErrorCode = "canceled"): void {
		for (const id of this.pending.keys()) {
			const entry = this.pending.get(id);
			if (!entry) continue;
			this.remove(id, entry);
			entry.reject(new SessionBindError(code));
		}
		this.byOwner.clear();
		this.pending.destroy();
	}

	/** 同一会话已有等待中的请求时就地作废 */
	private cancelByOwner(owner: string, selfSessionId: string, code: SessionBindErrorCode): void {
		const key = ownerKey(owner, selfSessionId);
		const id = this.byOwner.get(key);
		if (!id) return;

		const entry = this.pending.get(id);
		this.byOwner.delete(key);
		if (!entry) return;

		this.remove(id, entry);
		entry.reject(new SessionBindError(code));
	}

	/** 从两张表中摘除并停掉定时器 */
	private remove(bindId: string, entry: PendingBind): void {
		this.pending.delete(bindId);
		if (entry.timer !== null) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		const key = ownerKey(entry.owner, entry.selfSessionId);
		if (this.byOwner.get(key) === bindId) this.byOwner.delete(key);
	}

	/** 生成一个当前未占用的 bindId */
	private newId(): string {
		let id: string;
		do {
			id = "b" + uuid().replace(/-/g, "").toLowerCase();
		} while (this.pending.has(id));
		return id;
	}

	/** 定时器不应独自撑住进程 */
	private unref(timer: ReturnType<typeof setTimeout>): void {
		if (typeof timer === "object" && timer !== null && "unref" in timer) {
			(timer as { unref: () => void }).unref();
		}
	}
}

function ownerKey(owner: string, sessionId: string): string {
	return `${owner}\u0000${sessionId}`;
}
