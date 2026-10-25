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
import type { AcceptorQuery, AcceptorSnapshot } from "./types";

/**
 * 请求体
 *
 * 三种 action 都可以带分页参数: `override` / `reset` 也要按用户**当前看的那一页**
 * 返回, 否则操作完页面会跳回第一页。
 */
export type AcceptorAPIRequest = { botId: string } & AcceptorQuery & (
	| { action: "state" }
	| { action: "override"; unionId: string; adapter: string }
	| { action: "reset"; unionId: string }
);

/** handler 需要的服务端能力 (由 index.ts 注入) */
export type AcceptorAPIDeps = {
	/** 取某个 Bot 的当前页快照 */
	snapshot(botId: string, options: AcceptorQuery): AcceptorSnapshot;
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

/** 可缺省的字符串字段 (函数型): 非字符串一律当没给, 不为此报错 */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * 可缺省的非负整数字段
 *
 * 缺省合法(`undefined`), 但给了个字符串或负数是调用方写错了 —— 这里报 400, 而不是
 * 默默当成 0: 分页算错只会让用户看到“莫名其妙的某一页”, 比报错难查得多。
 */
function optionalCount(body: Record<string, unknown>, key: string): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw fail(`字段 ${key} 必须是非负数`);
	}
	return Math.floor(value);
}

/** 取出分页参数 (三种 action 共用) */
function readQuery(input: Record<string, unknown>): AcceptorQuery {
	return {
		query: optionalString(input, "query"),
		offset: optionalCount(input, "offset"),
		limit: optionalCount(input, "limit"),
	};
}

/** 把请求体解析成内部命令; 形状不对直接 400 */
export function parseRequest(body: unknown): AcceptorAPIRequest {
	const input = asRecord(body);
	const action = input.action;
	const botId = requireString(input, "botId");
	const paging = readQuery(input);

	switch (action) {
	case "state":
		return { action: "state", botId, ...paging };

	case "override":
		return {
			action: "override",
			botId,
			unionId: requireString(input, "unionId"),
			adapter: requireString(input, "adapter"),
			...paging,
		};

	case "reset":
		return {
			action: "reset",
			botId,
			unionId: requireString(input, "unionId"),
			...paging,
		};

	default:
		throw fail(`未知的 action: ${JSON.stringify(action)}`);
	}
}

/**
 * 生成端点 handler
 *
 * 任何 action 都返回操作后的**当前页**快照 —— 前端只有一条数据路径, 不用为
 * “换人之后要不要再拉一次”分情况处理, 也不会因操作而跳页。
 */
export function createAcceptorHandler(deps: AcceptorAPIDeps): (body: unknown) => AcceptorSnapshot {
	return (body: unknown): AcceptorSnapshot => {
		const request = parseRequest(body);
		const options: AcceptorQuery = {
			query: request.query,
			offset: request.offset,
			limit: request.limit,
		};

		switch (request.action) {
		case "override":
			deps.override(request.botId, request.unionId, request.adapter);
			return deps.snapshot(request.botId, options);

		case "reset":
			deps.resetSession(request.botId, request.unionId);
			return deps.snapshot(request.botId, options);

		case "state":
			return deps.snapshot(request.botId, options);
		}
	};
}
