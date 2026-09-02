# 事件

事件描述了"平台侧发生了什么", 是框架与聊天平台之间通信的载体之一

事件的方向为 **平台 -> Bot**: 平台发生动态时, 适配器插件将其转换为事件并派发给Bot, 框架再依据事件类型创建对应的[`Entity`](../objects/entity.md), 插件通过实体感知平台动态并做出响应

## 事件流向

```
平台 --推送--> 适配器 --dispatch--> Bot --创建实体--> 插件
```

1. 平台向适配器推送动态(如收到新消息)
2. 适配器将动态转换为事件, 调用`ctx.bot.dispatch(event)`派发给Bot ([适配器上下文指路](../plugin/contexts/adapter.md))
3. Bot根据事件的`type`创建对应的实体
4. 实体进入处理流程, 最终交由插件处理

## 事件列表

目前框架支持以下事件:

- [`BotEvent`](event.md): 所有事件的通用结构
- [`MessageCreateEvent`](message-create.md): 用户向会话发送了一条新消息, 对应事件类型`message.create`
