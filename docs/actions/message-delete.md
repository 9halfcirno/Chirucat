# MessageDelete

## 概述

该Action表示撤回指定会话的一条消息, 对应Action类型`message.delete`

插件可从`Message.delete`或`Entity.action`方法触发该Action

## 结构

```ts
interface MessageDelete {
	type: "message.delete";
	// 目标会话框架id(会话uuid)
	session: string;
	// 消息ID
	id: string;
}
```

### 字段

- `type`: 固定为`message.delete`
- `session`: 目标会话的框架id(会话uuid), 适配器应使用[`ctx.session.query`](../plugin/contexts/adapter.md)解析为平台会话后再发送
- `id`: 要撤回的消息的ID, 可从`Message.id`或`message.send`动作的响应获取

## 响应

该Action响应成功时返回如下

```ts
{
	success: true;   // 响应成功标志
}
```
