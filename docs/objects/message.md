# Message对象

## 概述

该对象继承自[`Entity`](entity.md)

## 结构

除继承来的属性外, 该对象还拥有以下属性

### 字段

- `text`: 消息纯文本内容
- `blocks`: 消息块(`MessageBlock`)数组
- `sender`: 消息发送者信息
  - `id`: 发送者账号uuid
  - `unionId`: 发送者跨平台uuid
  - `name`: 发送者昵称
- `session`: 消息来源会话信息
  - `id`: 会话uuid
  - `type`: 会话类型, 值为`private`, `group`, `channel`其中之一

# MessageBlock对象

## 概述

该对象表示富文本消息的其中一段消息

## 结构

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
	text: string; // 文本内容
}
```

**image**
```ts
{
	type: "image";
	url: string; // 图片URL
	file?: string; // 占位, 目前无实际用途
}
```

**mention**
```ts
{
	type: "mention";
	id: string; // 提及用户的账号uuid
}
```