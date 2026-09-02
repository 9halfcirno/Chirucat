# 插件适配器上下文

该上下文为适配器插件上下文, 提供了主动触发事件和处理BotAction的能力, 同时继承了[`PluginContext`](./normal.md)使也具备普通插件能力(但是也不要什么都写成适配器类型插件)

该上下文提供以下能力

- [Bot双向通信](#bot双向通信)
- [信息转换](#用户和会话信息转换)

## Bot双向通信

### bot对象

该对象非`Bot`实例, 而是对Bot核心方法的封装

该对象有以下方法:

- `dispatch(event: BotEvent)`: 向Bot发送一个事件, 实现平台 -> Bot

- `onAction(handler: (action: BotAction, extra: Record<string, any>) => void)`: 注册Bot动作处理, 以实现Bot -> 平台通信

## 用户和会话信息转换

### user对象

该对象实现 用户平台信息 <-> 账号uuid 的转换

由于框架使用账号uuid + 跨平台uuid, 所以要实现双向通信必须使用该对象

该对象有以下方法:

- `get(platform: string, id: string): string`: 传入平台名和用户平台id, 返回用户账号uuid, 在构建事件时必须使用用该方法做转换
- `query(uuid: string): UserPlatformInfo | null`: 通过账号uuid查询对应的平台信息, 如果未找到返回null

```ts
type UserPlatformInfo = {
	id: string; // 用户平台id
	platform: string; //该uuid所属平台
}
```

### session对象

该对象实现 平台聊天窗口 <-> 会话uuid 的转换

在构建事件/向平台发送请求时必须使用该对象做转换

该对象有以下方法:

- `get(platform: string, type: PlatformType, id: string): string`: 传入平台名, 聊天窗口类型和会话平台id, 返回会话uuid, 在构建事件时必须使用用该方法做转换
- `query(uuid: string): SessionPlatformInfo | null`: 通过会话uuid查询对应的平台信息, 如果未找到返回null

```ts
type SessionType = "private" | "group" | "channel"
type SessionPlatformInfo = {
	platform: string; // 会话所属平台
	type: SessionType; // 会话类型
	id: string; // 会话平台id
}
```

---

**在编写适配器插件时, 请务必遵守所有规则! 以防出现严重问题**

能力越大, 责任越大