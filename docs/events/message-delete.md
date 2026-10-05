# MessageDeleteEvent

> 该事件为可选实现, 因考虑到并非所有平台均会提供

## 概述

该事件表示用户撤回了一条消息, 对应事件类型`message.delete`

## 结构

### 通用字段

该事件继承[`BotEvent`](event.md)的全部字段, 其中:

- `type`: 固定为`message.delete`

### 专属字段

- `messageId`: 平台推送消息携带的消息id
- `operatorId`: 操作者框架id(账号uuid), 应使用[`ctx.user.get`](../plugin/contexts/adapter.md)转换得到
- `operatorName`: 操作者昵称
- `sessionType`: 会话窗口类型, 值为`private`(私聊), `group`(群聊), `channel`(频道)其中之一
- `sessionId`: 会话框架id(会话uuid), 应使用[`ctx.session.get`](../plugin/contexts/adapter.md)从平台会话id转换得到

## 构造示例

参考OneBot11适配器收到群消息撤回事件后的构造方式(别问为什么不是QQ因为根本没有这个事件):

```ts
ctx.bot.dispatch({
	type: "message.delete",
	messageId: String(data.message_id),
	operatorId: ctx.user.get("qq", String(data.operator_id)), // 平台用户id -> 账号uuid
	operatorName: operatorName, // 见下方"操作者昵称"
	sessionType: "group",
	sessionId: ctx.session.get("qq", "group", String(data.group_id)), // 平台会话id -> 会话uuid
	time: Date.now(),
	extra: {
		notice_type: data.notice_type
	},
	platform: "qq",
	source: data
})
```