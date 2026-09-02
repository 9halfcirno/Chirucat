# MessageCreateEvent

## 概述

该事件表示用户向会话发送了一条新消息, 对应事件类型`message.create`, 是当前唯一已支持的事件

平台收到新消息后, 适配器将其转换为该事件并派发给Bot; Bot会依据该事件创建[`Message`对象](../objects/message.md), 并进入消息处理流程(消息过滤 -> 指令匹配 -> [插件消息回调](../plugin/contexts/normal.md)), 插件在消息回调中收到的`Message`对象即为该事件产生的实体

## 结构

### 通用字段

该事件继承[`BotEvent`](event.md)的全部字段(`type`, `time`, `platform`, `extra`), 其中:

- `type`: 固定为`message.create`

### 专属字段

- `senderId`: 发送者框架id(账号uuid), 应使用[`ctx.user.get`](../plugin/contexts/adapter.md)从发送者平台id转换得到
- `senderName`: 发送者昵称
- `sessionType`: 会话窗口类型, 值为`private`(私聊), `group`(群聊), `channel`(频道)其中之一
- `sessionId`: 会话框架id(会话uuid), 应使用[`ctx.session.get`](../plugin/contexts/adapter.md)从平台会话id转换得到
- `text`: 消息纯文本内容
- `richContent`: 消息富文本内容, 为[`MessageBlock`](../objects/message.md)数组

### 与Message实体的字段对应

派发后创建的`Message`实体与事件的字段对应关系如下(完整结构见[Message对象](../objects/message.md)):

- `senderId`/`senderName` -> `sender.id`/`sender.name`
- `sessionId`/`sessionType` -> `session.id`/`session.type`
- `text` -> `text`
- `richContent` -> `blocks`

## 构造示例

参考QQ适配器收到群@消息(`GROUP_AT_MESSAGE_CREATE`)后的构造方式:

```ts
ctx.bot.dispatch({
	type: "message.create",
	senderId: ctx.user.get("qq", data.author.id), // 平台用户id -> 账号uuid
	senderName: data.author.username,
	sessionType: "group",
	sessionId: ctx.session.get("qq", "group", data.group_openid), // 平台会话id -> 会话uuid
	text: data.content.trim(),
	richContent: [{ type: "text", text: data.content.trim() }],
	time: Date.now(),
	extra: {
		msg_id: data.id // 被动回复时需要传回平台的消息id
	},
	platform: "qq"
})
```

需要注意:

- `senderId`和`sessionId`必须通过[`ctx.user.get`/`ctx.session.get`](../plugin/contexts/adapter.md)完成平台信息到框架id的转换, 不能直接填入平台原始id
- 平台富文本(图片, @等)需要适配器解析为对应的[`MessageBlock`](../objects/message.md), 纯文本消息可直接放入`text`, 并按上例填入`richContent`
- 被动回复所需的平台私有数据(如消息id)应放入`extra`, 插件调用`Message.reply`等方法发送Action时, 该对象会原样传回适配器
