/**
 * OneBot11 适配器
 *
 * 平台 -> Bot: 收到 OneBot 事件推送后转换为 message.create 并 dispatch
 * Bot -> 平台: 通过 ctx.bot.onAction 接收 message.send, 经 WS 调用 OneBot API
 */

const PLATFORM = "qq";
const API_TIMEOUT = 15000;
const CQ_PATTERN = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;

// 插件实例状态
let ctxRef = null;
let socket = null;
let stopped = false;
let reconnectTimer = null;
let echoSeq = 0;
let selfId = null;
/** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
const pendingCalls = new Map();
/** @type {Map<string, RegExp>} */
const regexCache = new Map();

export default {
	init(ctx) {
		ctxRef = ctx;
		stopped = false;
		selfId = null;

		ctx.bot.onAction(async (action) => {
			try {
				await handleAction(ctx, action);
			} catch (e) {
				ctx.logger.error(`[onebot11] 处理 Action 失败: ${e?.message ?? e}`);
			}
		});

		connect();
		ctx.logger.log("[onebot11] 适配器已启动");
	},

	unload() {
		stopped = true;

		if (reconnectTimer !== null) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}

		failAllPending("适配器已卸载");
		regexCache.clear();

		const ws = socket;
		socket = null;
		if (ws) {
			try {
				ws.close(1000, "plugin unload");
			} catch {
				/* ignore */
			}
		}

		ctxRef = null;
	},

	error(e) {
		ctxRef?.logger.error(`[onebot11] 运行时错误: ${e?.message ?? e}`);
	},
};


function connect() {
	const ctx = ctxRef;
	if (stopped || !ctx) return;

	if (typeof WebSocket === "undefined") {
		ctx.logger.error("[onebot11] 当前运行环境不支持 WebSocket, 需要 Node 22+");
		return;
	}

	const rawUrl = String(ctx.config.get("url", "") || "").trim();
	if (!rawUrl) {
		ctx.logger.error("[onebot11] 未配置 WebSocket 地址, 跳过连接");
		return;
	}

	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		ctx.logger.error(`[onebot11] 非法的 WebSocket 地址: ${rawUrl}`);
		return;
	}

	const token = String(ctx.config.get("accessToken", "") || "");
	if (token) url.searchParams.set("access_token", token);

	let ws;
	try {
		ws = new WebSocket(url.toString());
	} catch (e) {
		ctx.logger.error(`[onebot11] 创建连接失败: ${e?.message ?? e}`);
		scheduleReconnect();
		return;
	}

	socket = ws;
	ctx.logger.log(`[onebot11] 正在连接 ${url.origin}${url.pathname}`);

	ws.onopen = () => {
		if (socket !== ws) return;
		ctx.logger.log("[onebot11] 连接已建立");
	};

	ws.onmessage = (ev) => {
		if (socket !== ws) return;
		handleRawMessage(ev.data);
	};

	ws.onerror = () => {
		if (socket !== ws) return;
		ctx.logger.warn("[onebot11] WebSocket 发生错误");
	};

	ws.onclose = (ev) => {
		if (socket !== ws) return;
		socket = null;
		failAllPending("OneBot 连接已关闭");
		ctx.logger.warn(`[onebot11] 连接已关闭 (code=${ev?.code ?? "?"})`);
		scheduleReconnect();
	};
}

function scheduleReconnect() {
	const ctx = ctxRef;
	if (stopped || !ctx) return;

	if (!ctx.config.get("reconnect", true)) {
		ctx.logger.log("[onebot11] 自动重连已关闭");
		return;
	}
	if (reconnectTimer !== null) return;

	const delay = Number(ctx.config.get("reconnectInterval", 5000)) || 5000;
	ctx.logger.log(`[onebot11] ${delay}ms 后尝试重连`);

	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, delay);
}


function handleRawMessage(raw) {
	const ctx = ctxRef;
	if (!ctx) return;

	let data;
	try {
		data = JSON.parse(typeof raw === "string" ? raw : String(raw));
	} catch {
		ctx.logger.warn("[onebot11] 收到非 JSON 数据, 已忽略");
		return;
	}
	if (!data || typeof data !== "object") return;

	// API 调用响应
	if ("echo" in data) {
		resolveCall(data);
		return;
	}

	// 元事件: 记录 self_id
	if (data.post_type === "meta_event") {
		if (data.self_id != null) selfId = String(data.self_id);
		return;
	}

	// 消息事件
	if (data.post_type === "message" || data.post_type === "message_sent") {
		if (data.post_type === "message_sent" && ctx.config.get("ignoreSelf", true)) return;
		handleMessageEvent(data);
		return;
	}

	// 其余事件类型暂不支持, 静默忽略
}

function handleMessageEvent(data) {
	const ctx = ctxRef;
	if (!ctx) return;

	const messageType = data.message_type;
	if (messageType !== "private" && messageType !== "group") return;

	// 消息类型过滤
	const allowed = ctx.config.get("sessionTypes", ["private", "group"]);
	if (Array.isArray(allowed) && !allowed.includes(messageType)) return;

	if (data.self_id != null) selfId = String(data.self_id);

	const sessionType = messageType === "group" ? "group" : "private";
	const rawSessionId = messageType === "group" ? data.group_id : data.user_id;
	if (rawSessionId === undefined || rawSessionId === null) return;

	const senderPlatformId = data.user_id;
	if (senderPlatformId === undefined || senderPlatformId === null) return;

	// 忽略机器人自己
	if (ctx.config.get("ignoreSelf", true) && selfId !== null && String(senderPlatformId) === selfId) {
		return;
	}

	const blocks = parseMessage(data.message);
	const text = blocksToText(blocks);

	// 仅 @ 机器人
	if (ctx.config.get("atOnly", false) && sessionType === "group") {
		if (selfId === null) return;
		const selfUuid = ctx.user.get(PLATFORM, selfId);
		const mentioned = blocks.some((b) => b.type === "mention" && b.id === selfUuid);
		if (!mentioned) return;
	}

	// 消息内容过滤
	if (!passesContentFilter(ctx, text)) return;

	const time = typeof data.time === "number" ? data.time * 1000 : Date.now();

	ctx.bot.dispatch({
		type: "message.create",
		messageId: data.message_id != null ? String(data.message_id) : "",
		senderId: ctx.user.get(PLATFORM, String(senderPlatformId)),
		senderName: pickSenderName(data),
		sessionType,
		sessionId: ctx.session.get(PLATFORM, sessionType, String(rawSessionId)),
		text,
		richContent: blocks,
		quoteToken: data.message_id,
		time,
		platform: PLATFORM,
		extra: {
			message_id: data.message_id,
			message_type: messageType,
			group_id: data.group_id,
			user_id: data.user_id,
			self_id: selfId,
			raw_message: data.raw_message,
		},
		source: data,
	});
}

/* 内容过滤  */

/**
 * 判断消息文本是否通过内容过滤
 * - 未启用过滤 -> 通过
 * - 启用但无有效规则 -> 通过
 * - 启用且有规则 -> 匹配任一规则即通过
 */
function passesContentFilter(ctx, text) {
	if (!ctx.config.get("contentFilter", false)) return true;

	const rules = ctx.config.get("filterRules", []);
	if (!Array.isArray(rules)) return true;

	let hasRule = false;
	for (const rule of rules) {
		if (!rule || rule.enabled === false) continue;

		const value = String(rule.value ?? "");
		if (!value) continue;
		hasRule = true;

		if (matchRule(text, rule.type, value)) return true;
	}

	return hasRule ? false : true;
}

function matchRule(text, type, value) {
	switch (type) {
		case "include":
			return text.includes(value);
		case "start":
			return text.startsWith(value);
		case "end":
			return text.endsWith(value);
		case "full":
			return text === value;
		case "regex": {
			const re = getRegex(value);
			if (!re) return false;
			re.lastIndex = 0;
			return re.test(text);
		}
		default:
			return false;
	}
}

function getRegex(pattern) {
	let re = regexCache.get(pattern);
	if (re !== undefined) return re;

	try {
		re = new RegExp(pattern);
		regexCache.set(pattern, re);
		return re;
	} catch (e) {
		ctxRef?.logger.warn(`[onebot11] 非法正则 "${pattern}": ${e?.message ?? e}`);
		regexCache.set(pattern, null);
		return null;
	}
}

function pickSenderName(data) {
	const sender = data.sender;
	if (sender && typeof sender === "object") {
		if (sender.card) return String(sender.card);
		if (sender.nickname) return String(sender.nickname);
	}
	return String(data.user_id ?? "");
}


async function handleAction(ctx, action) {
	if (!action || action.type !== "message.send") return;

	const session = ctx.session.query(action.session);
	if (!session) {
		ctx.logger.warn(`[onebot11] 无法解析目标会话: ${action.session}`);
		return;
	}
	if (session.platform !== PLATFORM) return;

	let message = toOneBotMessage(action.message);

	if (action.quote) {
		if (!Array.isArray(message)) {
			message = [{ type: "text", data: { text: message } }]
		};
		message.unshift({
			type: "reply",
			data: {
				id: action.quote
			}
		})
	}

	if (session.type === "group") {
		await callApi("send_group_msg", {
			group_id: Number(session.id),
			message,
		});
	} else if (session.type === "private") {
		await callApi("send_private_msg", {
			user_id: Number(session.id),
			message,
		});
	} else {
		ctx.logger.warn(`[onebot11] 不支持的会话类型: ${session.type}`);
	}
}

function toOneBotMessage(message) {
	if (typeof message === "string") return message;
	if (!Array.isArray(message)) return String(message ?? "");

	const segments = [];
	for (const block of message) {
		if (!block || typeof block !== "object") continue;

		switch (block.type) {
			case "text":
				if (block.text) segments.push({ type: "text", data: { text: String(block.text) } });
				break;

			case "image":
				if (block.url) segments.push({ type: "image", data: { file: String(block.url) } });
				break;

			case "mention": {
				const info = ctxRef ? ctxRef.user.query(block.id) : null;
				if (info && info.platform === PLATFORM) {
					segments.push({ type: "at", data: { qq: info.id } });
				} else {
					segments.push({ type: "text", data: { text: `@${block.name ?? ""}` } });
				}
				break;
			}

			default:
				break;
		}
	}
	return segments;
}


function callApi(action, params) {
	return new Promise((resolve, reject) => {
		if (!socket || socket.readyState !== 1 /* OPEN */) {
			reject(new Error("OneBot 连接未就绪"));
			return;
		}

		const echo = `chirucat-${Date.now()}-${++echoSeq}`;
		const timer = setTimeout(() => {
			pendingCalls.delete(echo);
			reject(new Error(`OneBot API 超时: ${action}`));
		}, API_TIMEOUT);

		pendingCalls.set(echo, { resolve, reject, timer });

		try {
			socket.send(JSON.stringify({ action, params, echo }));
		} catch (e) {
			clearTimeout(timer);
			pendingCalls.delete(echo);
			reject(e);
		}
	});
}

function resolveCall(data) {
	const echo = String(data.echo);
	const pending = pendingCalls.get(echo);
	if (!pending) return;

	pendingCalls.delete(echo);
	clearTimeout(pending.timer);

	const ok = data.status === "ok" || data.retcode === 0;
	if (ok) {
		pending.resolve(data.data);
	} else {
		const detail = data.message ?? data.msg ?? data.wording ?? "";
		pending.reject(new Error(`OneBot API 错误 (retcode=${data.retcode}): ${detail}`));
	}
}

function failAllPending(reason) {
	for (const pending of pendingCalls.values()) {
		clearTimeout(pending.timer);
		pending.reject(new Error(reason));
	}
	pendingCalls.clear();
}


function parseMessage(message) {
	if (Array.isArray(message)) {
		const out = [];
		for (const seg of message) out.push(...segmentToBlocks(seg));
		return out;
	}
	if (typeof message === "string") return parseCQString(message);
	return [];
}

function segmentToBlocks(seg) {
	if (!seg || typeof seg !== "object") return [];
	const data = seg.data ?? {};

	switch (seg.type) {
		case "text":
			return data.text ? [{ type: "text", text: String(data.text) }] : [];

		case "image":
			return [{ type: "image", url: String(data.url ?? data.file ?? "") }];

		case "at": {
			const qq = data.qq;
			if (qq === undefined || qq === null || qq === "all") {
				return [{ type: "text", text: "@全体成员" }];
			}
			return [
				{
					type: "mention",
					id: ctxRef ? ctxRef.user.get(PLATFORM, String(qq)) : String(qq),
				},
			];
		}

		case "face":
			return [{ type: "text", text: `[表情${data.id ?? ""}]` }];

		default:
			// reply / json / forward 等暂不映射
			return [];
	}
}

function parseCQString(str) {
	const blocks = [];
	let cursor = 0;
	let match;

	CQ_PATTERN.lastIndex = 0;
	while ((match = CQ_PATTERN.exec(str)) !== null) {
		if (match.index > cursor) {
			pushText(blocks, str.slice(cursor, match.index));
		}
		blocks.push(...segmentToBlocks({ type: match[1], data: parseCQParams(match[2]) }));
		cursor = match.index + match[0].length;
	}
	if (cursor < str.length) pushText(blocks, str.slice(cursor));

	return blocks;
}

function parseCQParams(str) {
	const data = {};
	if (!str) return data;

	for (const pair of str.split(",")) {
		if (!pair) continue;
		const idx = pair.indexOf("=");
		if (idx === -1) continue;
		data[pair.slice(0, idx).trim()] = unescapeCQ(pair.slice(idx + 1));
	}
	return data;
}

function unescapeCQ(str) {
	return str
		.replace(/&#91;/g, "[")
		.replace(/&#93;/g, "]")
		.replace(/&#44;/g, ",")
		.replace(/&amp;/g, "&");
}

function pushText(blocks, raw) {
	const text = unescapeCQ(raw);
	if (text) blocks.push({ type: "text", text });
}

function blocksToText(blocks) {
	let out = "";
	for (const block of blocks) {
		if (block.type === "text") out += block.text;
		else if (block.type === "image") out += "[图片]";
		else if (block.type === "mention") out += `@${block.name ?? block.id}`;
	}
	return out;
}