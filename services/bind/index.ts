import type { Command } from "../../src/command/types";
import type { Message } from "../../src/entity/message";
import type { ServiceContext } from "../../src/plugin/services/context";
import type { ServiceModule } from "../../src/plugin/services/service";
import { SessionBind, SessionBindError } from "./session-bind";
import { UserBind } from "./user-bind";

/**
 * 跨平台绑定服务
 *
 * 提供两套互不相关的绑定:
 * - 账号绑定(`/bind [token]`): 把一个平台账号并进另一个账号的 union;
 * - 会话绑定(`/bind_session`): 把同一物理群/频道在两个适配器上的会话并入同一 union。
 *
 * 会话绑定协议见仓库根目录的 PLAN_SESSION_BIND.md。要点是两端都不做平台 ID
 * 转换: 发起方从自己的事件取会话 UUID, 对端从握手消息的事件取自己的会话 UUID,
 * 再交由框架的 SessionManager 归一化。
 */

/** 握手消息的内部指令名, 不开放配置: 用户侧指令与它必须保持可区分 */
const HANDSHAKE_COMMAND = "chirucat_service_bind_session";
/** 会话绑定指令的兜底名 */
const DEFAULT_SESSION_COMMAND = "bind_session";

let userCommand: Command | null = null;
let sessionCommand: Command | null = null;
let sessionBind: SessionBind | null = null;
let unwatch: (() => void) | null = null;

export default {
	init(ctx) {
		const ubm = new UserBind(ctx.core.user); // 服务插件加载时 Core 已 init, user 必然就绪
		const sbm = new SessionBind(ctx.core.session);
		sessionBind = sbm;

		// 内部握手指令: 只有持有 bindId 的对端才会真正消费, 其余消息静默忽略
		ctx.command.register(HANDSHAKE_COMMAND, (msg, args) => {
			if (!msg) return;

			try {
				const bindId = String(args[0] ?? "");
				const result = sbm.consume(bindId, msg.session.id, ownerOf(msg));
				if (result.ok) {
					ctx.logger.log(`会话绑定完成: ${describe(msg)} -> union ${short(result.unionId)}`);
				} else if (result.reason === "bind_failed") {
					ctx.logger.warn(`会话绑定失败(框架绑定抛错): ${describe(msg)}`);
				}
			} catch (e) {
				// Core 正在释放等边界情况: 不把异常带进消息处理链
				ctx.logger.error(`处理会话绑定握手失败: ${errorText(e)}`);
			}
		});

		registerCommands(ctx, ubm, sbm);

		// 配置热更新: 指令名变了就重建; 其他配置在每次触发时现读
		unwatch = ctx.config.watch((key) => {
			if (key === "command" || key === "session.command") registerCommands(ctx, ubm, sbm);
		});
	},

	unload() {
		// 先唤醒所有等待中的请求, 避免插件卸载后 promise 永久悬挂
		sessionBind?.dispose("canceled");
		sessionBind = null;
		unwatch?.();
		unwatch = null;
		// 指令由 ServiceContext.dispose 统一注销
		userCommand = null;
		sessionCommand = null;
	},
} as ServiceModule;

/* -------------------- 指令注册 -------------------- */

function registerCommands(ctx: ServiceContext, ubm: UserBind, sbm: SessionBind): void {
	if (userCommand) ctx.command.unregister(userCommand);
	if (sessionCommand) ctx.command.unregister(sessionCommand);

	const sessionName = readSessionCommand(ctx);
	const userName = readUserCommand(ctx, sessionName);

	// 消息开头的 @Bot 由适配器剥离, 因此这里直接挂框架指令即可
	userCommand = ctx.command.register(userName, createUserHandler(ctx, ubm, userName));
	sessionCommand = ctx.command.register(sessionName, (msg) => {
		void runSessionBind(ctx, sbm, sessionName, msg);
	});
}

/* -------------------- 账号绑定(原有逻辑) -------------------- */

function createUserHandler(ctx: ServiceContext, ubm: UserBind, commandName: string): Command["handler"] {
	return (msg, args) => {
		if (!msg) return; // 拿不到信息, 返回

		const token = args[0] as string;
		if (!token) { // 没token
			if (msg.session.type !== "private" || ctx.config.get("danger.allowGroup") as boolean) {
				msg.reply(`非私聊环境无法生成绑定令牌! 请尝试转移私聊`);
				return;
			}
			const aid = msg.sender.id; // 拿到account id
			const time = (ctx.config.get("duration") as number || 5 * 60) * 1000 || 300000; // 获取时长, 默认5min
			const newToken = ubm.new(aid, time);
			if (!newToken) {
				msg.reply(`生成绑定令牌失败!`);
				return;
			}
			msg.reply(`已生成绑定到此账号的绑定令牌! 请在 ${formatTime(time / 1000)} 内 @另一个Bot 使用 "/${commandName} [你的令牌]" 绑定!\n\n令牌: ${newToken}\n\n> 成功绑定后, 在对面Bot产生的数据将全部失去`);
		} else { // 有令牌
			const ori = msg.sender.id;
			const res = ubm.bind(ori, token);
			if (!res) return; // 理论上core释放时不会再收到消息?
			if (!res.success) {
				msg.reply(`绑定失败!\n原因: ${res.message}`);
				return;
			}
			msg.reply(`绑定成功! 当前账号已绑定到源账号数据`)
		}
	};
}

/* -------------------- 会话绑定 -------------------- */

async function runSessionBind(ctx: ServiceContext, sbm: SessionBind, commandName: string, msg: Message | null): Promise<void> {
	if (!msg) return;

	// 私聊没有"同一物理会话"的概念, 这里只回复提示, 不生成握手
	if (msg.session.type === "private") {
		await safeReply(msg, `会话绑定仅支持群聊/频道会话。私聊请使用账号绑定令牌。`);
		return;
	}

	// 同一条用户消息会被群里的每个适配器收到: 只有被 @ 的那一端发起握手,
	// 否则两端会互相发送、各自等待, 绑定方向不可控。
	if (msg.mentionedSelf !== true) return;

	const seconds = readSessionDuration(ctx);
	let request: { id: string; promise: Promise<void> };
	try {
		request = sbm.create(ownerOf(msg), msg.session.id, seconds * 1000);
	} catch (e) {
		await safeReply(msg, `会话绑定失败!\n原因: ${errorText(e)}`);
		return;
	}

	// 握手消息可能先失败, 而那时下面的 await 还没挂上: 先兜一层, 避免 unhandledRejection。
	// 这一层不影响后续 await 拿到同一个 rejection。
	request.promise.catch(() => { });

	// 额度②: 发起方把一次性 bindId 发到当前会话, 对端适配器收到后消费
	const sent = await safeReply(msg, `/${HANDSHAKE_COMMAND} ${request.id}`);
	if (!sent) {
		sbm.cancel(request.id, "send_failed");
		await safeReply(msg, `会话绑定失败!\n原因: 握手消息发送失败, 请检查当前 Bot 是否可发送消息。`);
		return;
	}

	try {
		await request.promise;
		// 额度③: 仅发起方回执, 对端保持静默
		await safeReply(msg, `会话绑定成功! 两端会话已归入同一 unionId, 后续去重与受理人判定会将其视为同一会话。`);
	} catch (e) {
		const code = e instanceof SessionBindError ? e.code : "bind_failed";
		// 已有更新的一次绑定: 旧请求静默作废, 不再打扰用户
		if (code === "superseded" || code === "canceled") return;

		const hint = code === "bind_timeout"
			? `\n可尝试 @ 另一个 Bot 后发送 /${commandName} 反向绑定, 或确认另一个 Bot 已开启群消息接收权限。`
			: "";
		await safeReply(msg, `会话绑定失败!\n原因: ${failureText(code)}${hint}`);
	}
}

/* -------------------- 工具 -------------------- */

/** 发起方/对端身份: 同一 Bot 的不同适配器也应视为不同端 */
function ownerOf(msg: Message): string {
	return `${msg.meta.bot}/${msg.meta.adapter}`;
}

function describe(msg: Message): string {
	return `${msg.meta.bot}/${msg.meta.adapter} ${msg.session.type}:${short(msg.session.id)}`;
}

async function safeReply(msg: Message, text: string): Promise<boolean> {
	try {
		const res = await msg.reply(text);
		return res?.success !== false;
	} catch {
		return false;
	}
}

function readSessionDuration(ctx: ServiceContext): number {
	const raw = ctx.config.get<number>("session.duration", 5);
	const seconds = typeof raw === "number" && Number.isFinite(raw) ? raw : Number(raw);
	// 低于 1 秒没有实际意义(收发本身就要耗时), 上限防止误填后请求长期悬挂
	return Math.min(60, Math.max(1, Math.round(seconds) || 5));
}

function readUserCommand(ctx: ServiceContext, sessionName: string): string {
	const raw = ctx.config.get("command");
	const name = normalizeCommandName(raw);
	// 与会话绑定/内部握手同名会让一条消息同时命中两套逻辑, 直接回退到默认名
	if (!name || name === HANDSHAKE_COMMAND || name === sessionName) return "bind";
	return name;
}

function readSessionCommand(ctx: ServiceContext): string {
	const raw = ctx.config.get("session.command");
	const name = normalizeCommandName(raw);
	// 内部握手指令必须以 chirucat_ 开头; 用户侧指令占用这个前缀会自触发。
	// "bind" 是账号绑定的默认名, 会话绑定占用它会让两条指令互相覆盖。
	if (!name || name === "bind" || name.startsWith("chirucat")) return DEFAULT_SESSION_COMMAND;
	return name;
}

function normalizeCommandName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw.trim().replace(/^\/+/, "");
}

function failureText(code: string): string {
	switch (code) {
		case "bind_timeout": return "等待对端响应超时";
		case "send_failed": return "握手消息发送失败";
		case "bind_failed": return "框架绑定会话时出错";
		default: return code;
	}
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function short(id: string): string {
	return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function formatTime(sec: number) {
	const h = Math.floor(sec / 3600);
	const min = Math.floor((sec % 3600) / 60);
	const s = sec % 60;

	const parts: string[] = [];
	if (h > 0) parts.push(`${h}小时`);
	if (min > 0) parts.push(`${min}分钟`);
	if (s > 0 || parts.length === 0) parts.push(`${s}秒`);

	return parts.join("");
}
