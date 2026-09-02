# Action

Action描述了"让机器人做一件事"的请求, 是框架与聊天平台之间通信的载体之一

Action的方向为 **Bot -> 平台**: 插件通过Action请求适配器向平台执行操作(如发送消息), 与[事件](../events/index.md)方向相反

## Action流向

```
插件 --action--> Bot --转发--> 适配器 --调用平台API--> 平台
```

1. 插件调用实体方法(如[`Message.reply`](../objects/message.md))发起Action
2. Bot将Action转发给源事件对应的适配器插件
3. 适配器插件的`onAction`处理器收到Action, 解析后调用平台API完成操作

Action携带两个隐含参数, 均由框架根据源事件自动传递, 适配器无需在Action中声明:

- **目标适配器**: Action来自某事件产生的实体, 因此会发往该事件来源的适配器插件
- **额外数据(extra)**: Action会携带源事件的`extra`, 适配器在构造事件时放入的平台私有数据(如`msg_id`), 在收到对应Action时原样可用

## 接收Action

适配器插件在`init`中通过`ctx.bot.onAction`注册Action处理器 ([适配器上下文指路](../plugin/contexts/adapter.md)), 可注册多个, 触发时按注册顺序调用

```ts
ctx.bot.onAction(async (action, extra) => {
	// 依据 action.type 分发处理
})
```

处理器的`action`参数类型为联合类型, 具体支持的Action见下列列表:

## Action列表

目前框架支持以下Action:

- [`MessageSend`](message-send.md): 向指定会话发送一条消息, 对应Action类型`message.send`
