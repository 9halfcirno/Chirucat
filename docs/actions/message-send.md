# MessageSend

## 概述

该Action表示向指定会话发送一条消息, 对应Action类型`message.send`, 是当前唯一已支持的Action

插件通常不直接构造该Action, 而是通过[`Message`对象](../objects/message.md)的`reply`方法等实体方法触发

## 结构

```ts
interface MessageSend {
	// 目标会话框架id(会话uuid)
	session: string;
	// 消息内容
	message: string | MessageBlock[];
	type: "message.send";
}
```

### 字段

- `type`: 固定为`message.send`
- `session`: 目标会话的框架id(会话uuid), 适配器应使用[`ctx.session.query`](../plugin/contexts/adapter.md)解析为平台会话后再发送
- `message`: 消息内容, 为纯文本字符串或[`MessageBlock`](../objects/message.md)数组

## 处理示例

参考QQ适配器的处理方式:

```ts
ctx.bot.onAction(async (action, extra) => {
	if (action.type !== "message.send") return;

	// 将框架会话uuid解析为平台会话, 解析不到则忽略
	const session = ctx.session.query(action.session);
	if (!session) return;
	const { platform, type, id } = session;

	// 按会话类型调用平台API, 群消息需要extra.msg_id以完成被动回复
	await fetch(`${BASE_URL}/v2/groups/${id}/messages`, {
		method: "POST",
		body: JSON.stringify({
			msg_type: 0,
			msg_id: extra?.msg_id,
			content: action.message.toString()
		})
	});
})
```

需要注意:

- `action.session`是框架会话uuid, 发送前必须使用`ctx.session.query`解析为平台会话id, 不能直接用于平台API
- 富文本(`MessageBlock`数组)如何渲染为平台消息由适配器决定, 当前适配器通常只处理纯文本
- `extra`来自源事件, 适配器在[构造事件](../events/message-create.md)时放入的平台私有数据(如`msg_id`)会原样出现在这里, 被动回复所需数据从该对象获取
