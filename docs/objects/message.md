# Message对象

## 概述

该对象继承自[`Entity`](entity.md)

## 结构

除继承来的属性外, 该对象还拥有以下属性

### 字段

- `id`: 消息的ID
- `token`: 消息的引用令牌
- `text`: 消息纯文本内容
- `blocks`: 消息块([`MessageBlockReceive`](#messageblock对象))数组
- `sender`: 消息发送者信息
  - `id`: 发送者账号uuid
  - `unionId`: 发送者跨平台uuid
  - `name`: 发送者昵称
- `session`: 消息来源会话信息
  - `id`: 会话uuid
  - `type`: 会话类型, 值为`private`, `group`, `channel`其中之一
- `quote`: 被引用的消息, 为[`MessageQuote`对象](#messagequote对象), 适配器未提供时为`undefined`

### 方法

- `reply(msg: string | MessageBlock[], option?: MessageReplyOption): Promise<void>`: 以当前消息被动回复 ([`MessageReplyOption类型指路`](#messagereplyoption对象))
- `delete()`: 撤回/删除该消息对象对应的消息, 通常遇要Bot拥有对应权限

# MessageQuote对象

## 概述

该对象表示被引用的一条消息

### 字段

- `id`: 消息的ID, 可能不存在, 具体看适配器是否能提供
- `text`: 消息纯文本内容
- `blocks`: 消息块(`MessageBlock`)数组
- `sender`: 消息发送者信息
  - `id`: 发送者账号uuid
  - `unionId`: 发送者跨平台uuid
  - `name`: 发送者昵称

# MessageReplyOption对象

## 概述

该对象用于`Message.reply`方法第二个选项参数, 为可选参数

## 字段

以下字段均为可选, 标`*`的代表实际效果取决于适配器实现

- `quote`*: 是否引用当前消息, 为`true`时会引用当前消息发送, 为字符串时会引用token为该值的目标消息

# MessageBlock对象

## 概述

该对象表示富文本消息的其中一段消息

协议里按方向拆成两个联合类型, 不要混用:

- `MessageBlockReceive`: **收**(事件)侧, 媒体块只有 `url`。事件的`richContent`与`quote.richContent`用它
- `MessageBlockSend`: **发**(Action)侧, 媒体块的 `url` 与 `buffer` 互斥。Action的`message`用它

## 结构

在双向通信场景下, 消息块的字段可能有所不同, 具体会在下方标注

通用结构如下:
```ts
{
	type: string;
	...
}
```

当`type`为以下值时对应的结构:

**text**
```ts
{
	type: "text";
	text: string; // [收/发] 文本内容
}
```

**mention**
```ts
{
	type: "mention";
	id: string; // [收/发] 提及用户的账号uuid
	name?: string; // [收] 提及用户的昵称
}
```

富媒体消息块的发送中, `url`和`buffer`为互斥字段

**image**
```ts
{
	type: "image";
	url: string; // [收/发] 图片URL
	buffer: NodeJS.ArrayBufferView; // [发] 图片Buffer
}
```

**video**
```ts
{
	type: "video";
	url: string; // [收/发] 视频URL
	buffer: NodeJS.ArrayBufferView; // [发] 视频Buffer
}
```

**audio**
```ts
{
	type: "audio";
	url: string; // [收/发] 音频URL
	buffer: NodeJS.ArrayBufferView; // [发] 音频Buffer
}
```