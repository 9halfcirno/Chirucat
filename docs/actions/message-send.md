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

参考QQ适配器的处理方式:

```ts
ctx.bot.onAction(async (action, extra) => {
	if (action.type !== "message.send") {
		return { success: false, error: `Unsupported action type: ${action.type}` };
	}

	// 将框架会话uuid解析为平台会话
	const session = ctx.session.query(action.session);
	if (!session) {
		return { success: false, error: `Session not found: ${action.session}` };
	}
	const { platform, type, id } = session;

	let body = {
		msg_type: 0,
		msg_id: extra?.msg_id,
		content: action.message.toString()
	};

	if (action.quote) {
		body.message_reference = {
			message_id: action.quote
		}
	}

	// 按会话类型调用平台API, 群消息需要extra.msg_id以完成被动回复
	try {
		let res = await fetch(`${BASE_URL}/v2/groups/${id}/messages`, {
			method: "POST",
			body: JSON.stringify(body)
		}).then(r => r.json());

		if (!res || !res.id) return { success: false, error: res.message } // 错误字段据真实api而定

		return { success: true, id: res.id, token: res.ext_info?.ref_idx }
	} catch(e) {
		return { success: false, error: (e as Error).message }
	}
})
```

需要注意:

- **处理器必须返回一个响应对象**。动作已经由框架按事件来源的适配器路由到对应插件, 所以 "不归我管" 不是合法状态: 返回 `undefined` (或任何假值) 会被框架记为 `ACTION_NOT_HANDLED`, 调用方只能看到一个没有原因的 `success: false`。解析不到会话、平台不匹配等都应返回带 `error` 的失败响应。
- `action.session`是框架会话uuid, 发送前必须使用`ctx.session.query`解析为平台会话id, 不能直接用于平台API
- 平台不匹配时**不要静默忽略**: 同样返回失败响应, 否则问题会被伪装成 `ACTION_NOT_HANDLED`
- 可选字段(如`ext_info`)取值要做空值保护: 发送成功后的响应解析异常会被当作发送失败上报
- `extra`来自源事件, 适配器在[构造事件](../events/message-create.md)时放入的平台私有数据(如`msg_id`)会原样出现在这里, 被动回复所需数据从该对象获取
- 富文本(`MessageBlock`数组)如何渲染为平台消息由适配器决定, 当前适配器通常只处理纯文本
