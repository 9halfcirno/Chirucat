# 服务插件上下文

该上下文为服务插件上下文, 提供**全局作用域**的插件能力 —— 与普通插件上下文[`PluginContext`](./normal.md)的方法签名一致, 但作用域是整个框架而非某个 Bot

服务插件不属于任何 Bot, 因此该上下文**不提供** Bot 维度能力(`action` / 当前 Bot 视图等), 改用 [`core` 对象](#core对象)访问框架核心的安全视图

该上下文提供以下能力

- [全局作用域](#全局作用域)
- [信息获取](#信息获取)
  - [core对象](#core对象)
- [消息处理](#消息处理)
  - [message对象](#message对象)
  - [command对象](#command对象)
- [事件处理](#事件处理)
  - [event对象](#event对象)
- [持久化存储](#持久化存储)
  - [kv对象](#kv对象)
  - [fs对象](#fs对象)
  - [plugin对象](#plugin对象)
- [其他](#其他)
  - [logger对象](#logger对象)
  - [config对象](#config对象)
  - [path对象](#path对象)
  - [插件间导入导出](#插件间导入导出exportsrequire)
- [不提供的能力](#不提供的能力)
- [禁忌!!除非你知道你在做什么](#绝对不应触碰的禁忌)

## 全局作用域

上下文里凡是有"注册"语义的能力(`message` / `command` / `event`), 注册的都是**全局表**, 而不是某个 Bot 的:

- `ctx.command` 注册的指令进入全局指令表; 每个 Bot 收到消息后先匹配自己的指令, 未命中再匹配全局指令表;
- `ctx.message` 注册的回调进入全局消息回调; 指令未命中时, 先触发 Bot 插件的消息回调, 再触发服务插件的消息回调;
- `ctx.event` 注册的过滤器作用于**事件传播本身**, 在所有 Bot 的处理链之前生效。

因此一个 `/bind` 这样的全局指令对所有 Bot 都生效, 而处理函数拿到的是**当前收到消息的那个 Bot** 的 `Message` 对象 —— 通过它执行回复、撤回等动作。

被消息过滤名单拦下的消息不会触发任何服务插件处理。

上下文释放(插件卸载)时, 上述注册项由框架统一清空。

## 信息获取

### core对象

框架核心的**安全视图**, 不是 `Core` 实例 —— `init` / `close` / `settings` / `internalDB` 这类启动与释放流程不会交给你。该对象只有以下几个入口:

- `bot`: 框架里有哪些 Bot, 以及启停它们
- `service`: 有哪些服务插件, 各自什么状态(只读)
- `webui`: WebUI 视图; **未启用 WebUI 时为 `null`**(目前没有公开方法)
- `user` / `session` / `profile` / `statistics`: 全局数据设施的视图

每个入口都是一份**白名单视图**: 只放行下面写明的方法, 其余成员读取为 `undefined`(白名单同时约束类型与运行时)。这不是"约定", 是运行时行为 —— 别指望用类型断言绕过去。

数据设施随框架启动建立, 服务插件加载时必然就绪; 框架关闭后再访问会抛出 `StateError`, 而不是交给你一个已释放的实例。

> `filterList` **不在** `ctx.core` 里: 消息过滤能力将抽离为独立服务插件, 名单视图已移出。

#### core.bot对象

不是 `Bot` 实例, 而是只读快照 + 被认可的启停动作

- `list(): BotInfo[]`: 全部已注册 Bot 的快照, 按注册顺序
- `get(id: string): BotInfo | null`: 单个 Bot 的快照, 未注册时为 `null`
- `has(id: string): boolean`: 该 id 的 Bot 是否已注册
- `start(...ids: string[]): Promise<void>`: 启动 Bot; 不传 id 时按期望态启动全部 Bot
- `stop(...ids: string[]): Promise<void>`: 停止 Bot; 不传 id 时按期望态停止全部 Bot

```ts
type BotInfo = {
	id: string;
	name: string | null;    // 展示名; 未配置时为 null
	running: boolean;       // 是否正在运行
	enabled: boolean;       // 持久化期望态: 是否期望启用
}
```

拿到的是快照, 所以没有 `action`、消息处理等 Bot 维度能力; 要操作某个 Bot 的行为, 请通过它发来的 `Message`。

#### core.service对象

服务插件注册表的**只读**视图

- `list(): ServiceInfo[]`: 全部已注册服务插件的快照, 按注册顺序
- `get(id: string): ServiceInfo | null`: 单个服务的快照, 未注册时为 `null`
- `has(id: string): boolean`: 该 id 的服务插件是否已注册
- `enabled(): string[]`: 已启用的服务插件 id, 按注册顺序

```ts
type ServiceInfo = {
	id: string;
	name?: string;
	version: string;
	author?: string;
	description?: string;
	status: "registered" | "loading" | "enabled" | "unloading" | "disabled";
	hasConfig: boolean;     // 是否声明了配置定义
}
```

服务插件的启停带依赖连带(见[持久化启停状态](../service.md#持久化启停状态)), 由框架与 WebUI 编排, 因此这里不提供启停方法 —— 插件不能停用自己或同伴。

#### core.user对象

用户标识与跨平台关系的视图

- `find(platform: string, id: string): string | null`: 纯查询, 平台账号 -> 账号 uuid; 不存在时为 `null`
- `get(platform: string, id: string): string`: 取或建, 平台账号 -> 账号 uuid(会写入账号记录)
- `has(platform: string, id: string): boolean`: 该平台账号是否已存在
- `query(accountId: string): UserPlatformInfo | null`: 账号 uuid -> 平台信息
- `queryMany(accountIds: string[]): Map<string, UserPlatformInfo>`: 批量反查平台信息
- `getUnion(accountId: string): string | null`: 账号 uuid -> 跨平台 id
- `getLast(accountId: string): string | null`: 账号上一次所在的跨平台 id
- `bind(internalId: string, accountUuid: string): boolean`: 把账号并入指定跨平台 id
- `unbind(internalId: string, accountUuid: string): boolean`: 把账号移出当前跨平台 id, 独立成组
- `restore(accountId: string): string | null`: 回到上一个跨平台 id
- `listMembers(internalId: string): UnionMember[]`: 某跨平台 id 下的全部账号
- `list(query: UserListQuery): { items: UserListItem[]; total: number }`: 分页查询账号列表
- `overview(): UserOverview`: 账号与跨平台 id 的规模概览

```ts
type UserPlatformInfo = {
	id: string;         // 用户平台id
	platform: string;   // 所属平台
}
type UnionMember = UserPlatformInfo & {
	accountId: string;  // 账号 uuid
}
```

`UserListQuery` / `UserListItem` / `UserOverview` 的形状见 `src/internal/user-manager.ts`。

约定: **落账由适配器负责**。适配器收到平台事件时写入账号与会话记录, 服务插件通常只用查询类方法; 需要"取或建"时才用 `get`。

#### core.session对象

会话标识的视图

- `get(platform: string, type: SessionType, id: string): string`: 取或建, 平台会话 -> 会话 uuid
- `find(platform: string, type: SessionType, id: string): string | null`: 纯查询, 不存在时为 `null`
- `has(platform: string, type: SessionType, id: string): boolean`: 该平台会话是否已存在
- `query(sessionId: string): SessionPlatformInfo | null`: 会话 uuid -> 平台信息
- `queryMany(ids: string[]): Map<string, SessionPlatformInfo>`: 批量反查平台信息

```ts
type SessionType = "private" | "group" | "channel"
type SessionPlatformInfo = {
	platform: string;   // 会话所属平台
	type: SessionType;  // 会话类型
	id: string;         // 会话平台id
}
```

#### core.profile对象

用户档案(昵称等展示信息)的视图

- `touch(accountId: string, name: string): void`: 记录一次昵称; 值未变化时不落盘, 空昵称忽略
- `get(accountId: string): UserProfile | null`: 取档案
- `getMany(accountIds: string[]): Map<string, UserProfile>`: 批量取档案

```ts
type UserProfile = {
	accountId: string;  // 账号 uuid
	name: string;       // 昵称
	avatar: string;     // 头像 URL(框架暂无采集来源)
	updatedAt: number;  // 最近一次更新时间(ms)
}
```

#### core.statistics对象

统计的**查询面**; 统计模块被关掉时为 `null`

- `summary(range: StatRange): StatSummary`
- `timeline(range: StatRange, bucketMs: number): StatPoint[]`
- `rank(range: StatRange, by: "session" | "platform", limit?: number): StatRankItem[]`
- `commands(range: StatRange, limit?: number): StatRankItem[]`
- `bots(): string[]`: 统计库里出现过的 Bot id
- `userActivity(userIds: string[], range: StatRange): Map<string, UserActivity>`

```ts
type StatRange = {
	from: number;    // 起始时间(ms)
	to: number;      // 结束时间(ms)
	botId?: string;  // 只看某个 Bot; 缺省为全部
}
```

采集入口(`record` / `recordSend` / `flush` / `close` 等)不开放 —— 它们由框架在消息链路上调用, 放给插件只会干扰统计口径。返回类型见 `src/statistics/types.ts`。

## 消息处理

以下两个对象的**方法签名与普通上下文完全一致**, 差别只在注册目标是全局表(见[全局作用域](#全局作用域)):

### message对象

方法参照[普通上下文的 `message` 对象](./normal.md#message对象); 处理函数收到的是"当前收到消息的那个 Bot"的 `Message`。

### command对象

方法参照[普通上下文的 `command` 对象](./normal.md#command对象)。

`exec(message)` 用全局指令表匹配消息; 传入纯文本时会以 `null` 作为回调的第一个参数(同普通上下文)。

## 事件处理

### event对象

**仅服务插件可用**。`ctx.message` 是"收到消息后做点什么", 而 `ctx.event` 干预的是**事件传播本身**: 适配器派发的事件在进入 Bot 的处理链之前, 先过一遍全部已启用服务插件的过滤器。

- `filter(predicate: (event: BotEvents, bot: Bot) => boolean): void`: 注册事件过滤器, 返回 `false` 表示拦截该事件
- `observe(handler: (event: BotEvents, bot: Bot) => unknown): void`: 注册事件观察回调, 返回值不被等待

```js
export default {
	init(ctx) {
		// 只放行消息事件, 其他事件一律拦住
		ctx.event.filter((event, bot) => event.type === "message.create");

		// 观察通过过滤的事件(包括 EntityFactory 不认识的裸事件)
		ctx.event.observe((event, bot) => {
			ctx.logger.log(`[${bot.id}] ${event.type}`);
		});
	}
};
```

约定:

- **AND 语义**: 遍历全部过滤器, 任一返回 `false` 就丢掉该事件;
- 第二个参数是**收到事件的 `Bot` 实例**(不是 `core.bot` 那样的只读快照), 便于做“只在某些 Bot 上放行”的判断 —— 它只应被当作判断依据(`id` / `name` 等), 不要拿它去操作 Bot;
- **过滤器抛错时按放行处理**并记录日志 —— 拦截是显式意图, 不能让一个出错的过滤器使事件无声消失;
- `observe` 不参与拦截, 只观察, 能拿到 `EntityFactory` 不认识、不会被任何处理链消费的事件;
- 过滤器与观察回调都注册在服务插件上, 卸载时自动清空, 只对**已启用**的服务插件生效;
- 回调里的期约不被等待, 只吞掉 `rejection`, 避免未处理的拒绝。

## 持久化存储

三种存储的用法与普通上下文一致, 差别只在根目录都落在**服务插件自己的数据目录** `data/services/<插件id>/`。

### kv对象

自动序列化/反序列化 JSON 的简易键值存储, 需先 `ctx.kv.init()`。方法见[普通上下文的 `kv` 对象](./normal.md#kv对象)。

### fs对象

插件数据目录(可读写)的文件读写。方法见[普通上下文的 `fs` 对象](./normal.md#fs对象)。

### plugin对象

插件代码目录的只读文件系统, 供读取自带的模板/资源。方法见[普通上下文的 `plugin` 对象](./normal.md#plugin对象)。

## 其他

### logger对象

框架统一日志对象, 支持输出到控制台/文件/WebUI, 方法见[普通上下文的 `logger` 对象](./normal.md#logger对象)。

### config对象

插件配置的**只读**视图, 方法与约定见[普通上下文的 `config` 对象](./normal.md#config对象)。

与普通插件唯一的差别是配置值是**全局**的: 写在 `configs/services/<插件id>.json`, 不按 Bot 隔离(普通插件写在各自 Bot 目录下)。

### path对象

插件相关路径

- `path.plugin`: 插件代码根目录
- `path.data`: 插件数据根目录, 即 `data/services/<插件id>/`(`fs` 与 `kv` 的根)

### 插件间导入导出(exports/require)

用法与[普通上下文](./normal.md#插件间导入导出exportsrequire)一致, 差异在可见性:

- 服务插件的导出对**所有 Bot 的插件**可见(普通插件之间只在同一个 Bot 内可见);
- Bot 插件的 `ctx.require` 先查本 Bot 的插件, 未命中再回退到服务插件; 同名时 Bot 私有导出优先;
- `ctx.require(serviceId)` 导入的是**其他服务插件**的导出, 目标没有导出时抛 `StateError`。

```js
// 服务插件 a
export default {
	init(ctx) {
		ctx.exports = { hello: () => "hi" };
	}
};
```

```js
// 另一个服务插件(或任意 Bot 的插件)
const a = ctx.require("a");
```

依赖关系仍然写在清单的 `dependencies` 里: 依赖先于本插件加载, 存在依赖环或依赖缺失时本插件拒绝加载。与普通上下文一样, **不要缓存 `require` 的返回值** —— 目标插件卸载后导出即被释放。

## 不提供的能力

服务插件不属于任何 Bot, 也不掌管框架的生命周期, 因此以下能力**不存在**(不是"未文档化", 是拿不到):

- Bot 维度: `ctx.action`、当前 Bot 视图 —— 拿到的 `Message` 已经绑定了它的 Bot;
- 框架生命周期: `Core.init` / `close` / `settings` / `internalDB`;
- 服务插件启停: `ServiceHost.load` / `unload` / `setEnabled` / `scan`;
- 统计采集: `record` / `flush` / `close`;
- WebUI 服务器生命周期: `start` / `relisten` / `updateSecurity` / `close`(WebUI 路由注册也尚未开放);
- 数据管理器的建表与连接句柄: `init` / `db`。

## 绝对不应触碰的禁忌

以下方法由框架调用, 插件不应直接使用:

### filterEvent方法

该方法用于框架向服务插件分发事件过滤器, 由事件派发链调用。

### observeEvent方法

该方法用于框架向服务插件分发事件观察回调, 由事件派发链调用。

### handleMessage方法

该方法用于框架向服务插件分发消息。

### dispose方法

该方法会销毁上下文, 仅在 `unload` 执行完后由框架主动调用, 你不应调用该方法。
