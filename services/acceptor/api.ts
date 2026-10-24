/**
 * 受理人服务的 WebUI 端点
 *
 * 只有三件事: 看快照、手工指定受理人、清掉某个会话的状态。三种操作的返回值统一
 * 是**操作后的完整快照** —— 页面点一下就能拿到新画面, 不必再补一次请求, 也不会
 * 出现"操作成功但表格还是旧的"这种瞬间不一致。
 *
 * 校验放在这里而不是 `index.ts`: 端点直接面对请求体, 它必须自己拒绝形状不对的
 * 输入(`botId` 缺失、`adapter` 是没见过的名字)。把受理人设成一个不存在的适配器
 * 等于让这个会话永久没人放行, 所以宁可 400。
 *
 * 依赖以参数注入, 这样自检脚本可以直接调用 handler, 不必起 HTTP 服务器。
 */
import type { AcceptorSnapshot } from "./types";

/** 请求体: `state` 看快照, `override` 换人, `reset` 清掉该会话 */
export type AcceptorAPIRequest =
	| { action: "state"; botId: string }
	| { action: "override"; botId: string; unionId: string; adapter: string }
	| { action: "reset"; botId: string; unionId: string };

/** handler 需要的服务端能力 (由 index.ts 注入) */
export type AcceptorAPIDeps = {
	/** 取某个 Bot 的快照 */
	snapshot(botId: string): AcceptorSnapshot;
	/** 手工指定受理人; 适配器不合法时应抛错 */
	override(botId: string, unionId: string, adapter: string): void;
	/** 清空一个会话的受理人状态 */
	resetSession(botId: string, unionId: string): void;
};

/** 前端拿得到的错误形状: 与核心 API 的 `{ err, code }` 约定一致 */
type APIError = { err: string; code: number };

function fail(message: string, code = 400): APIError {
	return { err: message, code };
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw fail("请求体必须是对象");
	}
	return value as Record<string, unknown>;
}

/** 必填的非空字符串字段 */
function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw fail(`缺少字段 ${key}`);
	}
	return value;
}

/** 把请求体解析成内部命令; 形状不对直接 400 */
export function parseRequest(body: unknown): AcceptorAPIRequest {
	const input = asRecord(body);
	const action = input.action;

	switch (action) {
	case "state":
		return { action: "state", botId: requireString(input, "botId") };

	case "override":
		return {
			action: "override",
			botId: requireString(input, "botId"),
			unionId: requireString(input, "unionId"),
			adapter: requireString(input, "adapter"),
		};

	case "reset":
		return {
			action: "reset",
			botId: requireString(input, "botId"),
			unionId: requireString(input, "unionId"),
		};

	default:
		throw fail(`未知的 action: ${JSON.stringify(action)}`);
	}
}

/**
 * 生成端点 handler
 *
 * 任何 action 都返回操作后的快照 —— 前端只有一条数据路径, 不用为"换人之后要不要
 * 再拉一次"分情况处理。
 */
export function createAcceptorHandler(deps: AcceptorAPIDeps): (body: unknown) => AcceptorSnapshot {
	return (body: unknown): AcceptorSnapshot => {
		const request = parseRequest(body);

		switch (request.action) {
		case "override":
			deps.override(request.botId, request.unionId, request.adapter);
			return deps.snapshot(request.botId);

		case "reset":
			deps.resetSession(request.botId, request.unionId);
			return deps.snapshot(request.botId);

		case "state":
			return deps.snapshot(request.botId);
		}
	};
}
