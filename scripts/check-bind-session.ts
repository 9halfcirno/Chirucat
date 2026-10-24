/**
 * 会话绑定协议自检: 验证 SessionBind 的一一次性消费、owner 防御、超时与作废路径。
 *
 * 这里不启动 Bot/适配器, 只把 SessionManager 与 SessionBind 接在内存库上跑 ——
 * 协议真正依赖的就是这两者, 指令注册与消息收发属于框架链路, 由类型检查覆盖。
 *
 * 用法: npx tsx scripts/check-bind-session.ts
 */
import sqlite from "better-sqlite3";
import { SessionManager } from "../src/internal/session-manager";
import { SessionBind, SessionBindError } from "../services/bind/session-bind";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ""}`);
	}
}

const db = new sqlite(":memory:");
// timer 默认 unref, 单跑脚本时进程会在超时用例前退出 —— 用一个 ref 的句柄把事件循环留住
const keepAlive = setInterval(() => { }, 1000);
const sessions = new SessionManager(db);
sessions.init();

// 同一物理群在两个适配器上的会话(platform_id 分别是群号和 group_openid)
const selfId = sessions.get("onebot11", "group", "123456");
const peerId = sessions.get("qq", "group", "OPENID_ABC");
const otherId = sessions.get("onebot11", "group", "999999");

const sb = new SessionBind(sessions);

/* ---------- 1. 正常路径 ---------- */

const first = sb.create("bot-a/onebot11", selfId, 1000);
first.promise.catch(() => { /* 下面会显式消费, 这里只防未处理拒绝 */ });
check("bindId 带字母前缀", /^b[0-9a-f]{32}$/.test(first.id), first.id);

check("无效 bindId 不消费", sb.consume("not-a-bind-id", peerId, "bot-b/qq").ok === false);
check("短 id 不误匹配", sb.consume(first.id.slice(0, 10), peerId, "bot-b/qq").ok === false);

const selfEcho = sb.consume(first.id, selfId, "bot-a/onebot11");
check(
	"发起方自己的回推不消费且保留条目",
	selfEcho.ok === false && selfEcho.reason === "self",
	JSON.stringify(selfEcho),
);

const done = sb.consume(first.id, peerId, "bot-b/qq");
check("对端消费成功", done.ok === true, JSON.stringify(done));
check(
	"两端会话归入同一 union",
	sessions.getUnion(selfId) === sessions.getUnion(peerId),
	`${sessions.getUnion(selfId)} / ${sessions.getUnion(peerId)}`,
);
check("bindId 一次性消费", sb.consume(first.id, otherId, "bot-c/onebot11").ok === false);

// 两端已经同组时再次绑定: 框架 bind 返回 false(无变更), 协议仍应视为成功
const again = sb.create("bot-a/onebot11", peerId, 1000);
again.promise.catch(() => { });
const againDone = sb.consume(again.id, selfId, "bot-b/onebot11");
check("已同组时重复绑定仍成功", againDone.ok === true, JSON.stringify(againDone));

/* ---------- 2. 超时 ---------- */

const timeout = sb.create("bot-a/onebot11", selfId, 30);
timeout.promise.catch(() => { });
let timeoutCode: string | null = null;
try {
	await timeout.promise;
} catch (e) {
	timeoutCode = e instanceof SessionBindError ? e.code : String(e);
}
check("TTL 到期以 bind_timeout 唤醒等待方", timeoutCode === "bind_timeout", String(timeoutCode));
check("超时后 bindId 不可再消费", sb.consume(timeout.id, peerId, "bot-b/qq").ok === false);

/* ---------- 3. 发送失败取消 ---------- */

const sendFail = sb.create("bot-a/onebot11", selfId, 1000);
sendFail.promise.catch(() => { });
sb.cancel(sendFail.id, "send_failed");
let sendFailCode: string | null = null;
try {
	await sendFail.promise;
} catch (e) {
	sendFailCode = e instanceof SessionBindError ? e.code : String(e);
}
check("发送失败可立即取消", sendFailCode === "send_failed", String(sendFailCode));

/* ---------- 4. 同一会话的重复请求 ---------- */

const oldReq = sb.create("bot-a/onebot11", selfId, 1000);
oldReq.promise.catch(() => { });
const newReq = sb.create("bot-a/onebot11", selfId, 1000);
newReq.promise.catch(() => { });

let oldCode: string | null = null;
try {
	await oldReq.promise;
} catch (e) {
	oldCode = e instanceof SessionBindError ? e.code : String(e);
}
check("同一会话的新请求作废旧请求", oldCode === "superseded", String(oldCode));
check("新请求仍可被对端消费", sb.consume(newReq.id, peerId, "bot-b/qq").ok === true);

/* ---------- 5. 对端会话不存在 ---------- */

const ghost = sb.create("bot-a/onebot11", selfId, 1000);
ghost.promise.catch(() => { });
const ghostResult = sb.consume(ghost.id, "00000000-0000-0000-0000-000000000000", "bot-b/qq");
check(
	"对端会话未登记时不消费",
	ghostResult.ok === false && ghostResult.reason === "peer_missing",
	JSON.stringify(ghostResult),
);

/* ---------- 6. 卸载清理 ---------- */

sb.dispose("canceled");
let disposed = false;
try {
	await ghost.promise;
} catch (e) {
	disposed = e instanceof SessionBindError && e.code === "canceled";
}
check("dispose 唤醒全部等待方", disposed);

db.close();
clearInterval(keepAlive);
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
