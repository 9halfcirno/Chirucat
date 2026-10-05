# MessageSend

## 概述

该Action表示向指定会话发送一条消息, 对应Action类型`message.send`

插件通常不直接构造该Action, 而是通过[`Message`对象](../objects/message.md)的`reply`方法等实体方法触发

## 结构

```ts
interface MessageSend {
	type: "message.send";
	// 目标会话框架id(会话uuid)
	session: string;
	// 消息内容
	message: string | MessageBlock[];
	// 引用的消息的引用Token
	quote: string | null;
}
```

### 字段

- `type`: 固定为`message.send`
- `session`: 目标会话的框架id(会话uuid), 适配器应使用[`ctx.session.query`](../plugin/contexts/adapter.md)解析为平台会话后再发送
- `message`: 消息内容, 为纯文本字符串或[`MessageBlock`](../objects/message.md)数组
- `quote`: 引用的消息的Token, 不为`null`时代表引用一条消息, 是适配器填写的`quoteToken`字段

## 响应

该Action响应成功时返回如下

```ts
{
	success: true;   // 响应成功标志
	id: string;      // 发送出去的消息id. 可用于撤回/修改
	token?: string;  // 发送的消息的引用token
}
```

## 处理示例

参考QQ适配器的处理方式(已省略媒体上传与错误包装):

```ts
// 将框架会话uuid解析为平台会话: 平台不匹配 / 类型不支持都返回失败
const info = ctx.session.query(action.session);
if (!info) return { success: false, error: `Session not found: ${action.session}`, code: "SESSION_NOT_FOUND" };
if (info.platform !== "qq") {
	return { success: false, error: `Platform mismatch: expected qq, got ${info.platform}`, code: "PLATFORM_MISMATCH" };
}
if (info.type !== "group" && info.type !== "private") {
	return { success: false, error: `Unsupported session type: ${info.type}`, code: "UNSUPPORTED_SESSION_TYPE" };
}

// 引用消息: QQ 用 message_reference.message_id 承载
const msgRef = action.quote ? { message_reference: { message_id: action.quote } } : {};

// 字符串内容直接发; 消息块数组要拆成"文本 + 媒体"
// 文本: 提及段换成平台openid后拼成 content(仅群聊支持@)
// 媒体: 每段单独上传拿 file_info, 再以 msg_type=7 逐条发送
try {
	const res = await fetch(`${BASE_URL}/v2/${info.type === "group" ? "groups" : "users"}/${info.id}/messages`, {
		method: "POST",
		headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			msg_type: 2,                      // 文本用 markdown 形态
			markdown: { content },
			msg_id: extra?.msg_id,            // 被动回复必须回传源事件的 msg_id
			msg_seq: nextSeq(extra),          // 同一 msg_id 下多条消息的序号需互不相同
			...msgRef
		})
	}).then(r => r.json());

	// 发送成功但缺 id 不能算成功: 后续撤回/引用都要用它
	if (!res?.id) return { success: false, error: `响应缺少消息 id: ${JSON.stringify(res)}` };

	const token = res.ext_info?.ref_idx;   // 可选字段, 缺失不代表失败
	return token ? { success: true, id: String(res.id), token } : { success: true, id: String(res.id) };
} catch (e) {
	return { success: false, error: (e as Error).message };
}
```

需要注意:

- **处理器必须返回一个响应对象**。动作已经由框架按事件来源的适配器路由到对应插件, 所以 "不归我管" 不是合法状态: 返回 `undefined` (或任何假值) 会被框架记为 `ACTION_NOT_HANDLED`, 调用方只能看到一个没有原因的 `success: false`。解析不到会话、平台不匹配等都应返回带 `error` 的失败响应。
- `action.session`是框架会话uuid, 发送前必须使用`ctx.session.query`解析为平台会话id, 不能直接用于平台API
- 平台不匹配时**不要静默忽略**: 同样返回失败响应, 否则问题会被伪装成 `ACTION_NOT_HANDLED`
- 可选字段(如`ext_info`)取值要做空值保护: 发送成功后的响应解析异常会被当作发送失败上报
- `extra`来自源事件, 适配器在[构造事件](../events/message-create.md)时放入的平台私有数据(如`msg_id`)会原样出现在这里, 被动回复所需数据从该对象获取
- 富文本(`MessageBlockSend`数组)如何渲染为平台消息由适配器决定。其中的媒体块可能用`url`, 也可能用`buffer`表达本地二进制, **两者都要实现**([协议跟进清单](../plugin/adapter.md#2-buffer-发送意图))
- 群聊里同一个被动回复窗口内发送多条消息时, 平台通常要求序号(`msg_seq`)递增, 否则后续消息会被丢弃
