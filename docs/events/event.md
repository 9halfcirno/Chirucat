# BotEvent

## 概述

该接口是所有事件的基础结构, 适配器向Bot派发的事件均遵循该结构

适配器插件收到平台推送后, 使用`ctx.bot.dispatch(event)`将事件派发给Bot, 事件即从平台流向框架 ([适配器上下文指路](../plugin/contexts/adapter.md))

## 结构

```ts
interface BotEvent {
	// 事件类型
	type: unknown;
	// 事件创建时间
	time: number;
	// 平台名, 如 `qq`, `discord`, `wechat`
	platform: string;
	// 扩展对象
	extra: Record<string, any>;
}
```

### 字段

- `type`: 事件类型, 框架依据该字段决定如何处理事件, 目前支持的值见[事件列表](index.md)
- `time`: 事件创建时间, 为毫秒时间戳, 通常取`Date.now()`
- `platform`: 事件来源平台名, 如`qq`, `discord`, `wechat`
- `extra`: 附加信息, 用于存放平台私有数据(如消息id); 插件通过该事件产生的实体发送`Action`时, 该对象会原样传回适配器 ([Entity对象](../objects/entity.md)), 因此需要被动回复的适配器应将回复所需的数据放入该字段

### 事件元数据

事件元数据(`BotEventMeta`)记录了事件的来源, 由框架在派发时自动附加, 适配器无需也不能主动填写

```ts
type BotEventMeta = {
	adapter: string; // 适配器插件的id
}
```

派发后生成的实体带有`meta`属性, 通过`entity.meta.adapter`可以得知该事件来自哪个适配器

## 派发事件

适配器通过`ctx.bot.dispatch(event)`派发事件, 除通用字段外, 事件还包含其类型专属的字段, 以`message.create`为例:

```ts
ctx.bot.dispatch({
	type: "message.create",
	time: Date.now(),
	platform: "qq",
	extra: {},
	// ... 该事件类型的专属字段, 见 message-create.md 文档
})
```

框架根据事件的`type`创建对应的[`Entity`](../objects/entity.md)并进入处理流程; 目前仅`message.create`事件有对应的处理, 派发其他类型的事件会被忽略
