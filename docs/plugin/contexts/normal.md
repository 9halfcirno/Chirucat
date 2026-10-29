# 插件普通上下文

该上下文为基本上下文, 其他类型上下文均继承自该上下文, 该上下文提供了插件最基本的功能, 其他类型上下文在此基础上扩展了更多功能

该上下文提供了以下能力

- [信息获取](#信息获取)
  - [Bot信息](#bot对象)
  - [配置](#config对象)
  - [用户信息](#user对象)
  - [会话信息](#session对象)
- [消息处理](#消息处理)
  - [普通回调](#message对象)
  - [指令回调](#command对象)
- [持久化存储](#持久化存储)
  - [KV存储](#kv对象)
  - [文件系统存储](#fs对象)
    - [只读FS对象](#只读fs对象)
  - [插件目录访问](#plugin对象)
- [定时任务](#定时任务)
  - [cron对象](#cron对象)
- [其他](#其他)
  - [日志记录](#logger对象)
  - [动作发送](#action方法)
  - [插件间导入导出](#插件间导入导出exportsrequire)
- [禁忌!!除非你知道你在做什么](#绝对不应触碰的禁忌)

## 信息获取

### bot对象

该对象非Bot实例, 仅作为数据提供使用

该对象拥有以下字段

- `id`: Bot标识符
- `name`: Bot显示的名字

### config对象

该对象用于读取插件配置, 这是一个**只读**视图。

配置的控件与默认值来自清单里的 `config` 定义文件; 配置值由用户在 WebUI 中修改。

- `get<T = unknown>(key: string, fallback?: T): T`: 取配置项, 支持点号路径与数组下标(`"offset"` / `"pro-group.extra"` / `"groups.0.id"`), 未配置时返回 `fallback`
- `has(key: string): boolean`: 该配置项是否有值
- `all(): object`: 一份配置值副本
- `watch(handler: (key, value, oldValue) => void): () => void`: 监听配置变更, 返回取消监听的函数

约定:

- 配置值与 WebUI 共享同一份实例, 每次 `get` 读到的都是最新值, **不要缓存返回值**
- `watch` 只在用户通过 WebUI 改动配置时触发(载入配置不算变更); 一次更新里每个发生变化的配置项调用一次, `key` 为配置项路径(`"offset"` / `"pro-group.extra"`), 表格的行改动只报表格自身的路径
- 监听随上下文释放自动注销; 回调里抛错不影响其它监听器, 也不会中断保存
- 插件自己的可变状态请使用 `kv` / `fs`; 配置属于用户, 插件侧不提供写入接口
- 未在清单里声明 `config` 的插件, `config` 为空配置(`get` 返回 `fallback`、`has` 为 `false`、`all` 为 `{}`), 无需判空

### user对象

该对象用于查询用户的信息

该对象拥有以下方法:

- `find(platform: string, id: string): string | null`: 通过平台名与用户平台id获取用户对应的框架账号id
- `query(accountId: string): UserPlatformInfo | null`: 通过用户框架id查询对应平台信息
- `getUnion(accountId: string): string | null`: 通过用户框架id查询对应跨平台id

三方法在查询不到已有信息时会返回null

```ts
type UserPlatformInfo = {
	id: string; // 用户平台id
	platform: string; //该uuid所属平台
}
```

### session对象

该对象用于查询会话的信息

- `find(platform: string, type: SessionType, id: string): string | null`: 通过平台名, 会话类型与会话平台id获取会话对应的框架账号id
- `query(sessionId: string): { platform: string, type: SessionType,id: string } | null`: 通过会话框架id查询对应平台信息

两方法在查询不到已有信息时会返回null

```ts
type SessionType = "private" | "group" | "channel"
type SessionPlatformInfo = {
	platform: string; // 会话所属平台
	type: SessionType; // 会话类型
	id: string; // 会话平台id
}
```

## 消息处理

### message对象

该对象用于注册消息回调, 插件可以通过该对象注册不同类型的消息回调函数, 以便在特定条件下触发相应的处理逻辑。

该对象有以下方法:

| 方法 | 第一参数 | 描述 |
| --- | --- | --- |
| `all`| 消息处理函数 | 注册一个全量消息回调, 该回调会在接收到任何消息时触发, 适用于需要处理所有消息的插件。 |
| `start` | 消息前缀(string) | 注册一个以指定前缀开头的消息回调, 该回调会在接收到以指定前缀开头的消息时触发 |
| `end` | 消息后缀(string) | 注册一个以指定后缀结尾的消息回调, 该回调会在接收到以指定后缀结尾的消息时触发 |
| `includes` | 消息包含(string) | 注册一个包含指定字符串的消息回调, 该回调会在接收到包含指定字符串的消息时触发 |
| `full` | 消息完全匹配(string) | 注册一个完全匹配指定字符串的消息回调, 该回调会在接收到完全匹配指定字符串的消息时触发 |
| `regex` | 正则表达式(RegExp) | 注册一个匹配指定正则表达式的消息回调, 如果使用`g`/`y`标识, 请手动重置`lastIndex`, 该回调会在接收到匹配指定正则表达式的消息时触发 |
| `match` | 消息断言函数(返回boolean) | 注册一个自定义消息匹配回调, 该回调会在接收到任何消息时触发, 并将消息传入回调函数, 回调函数返回true则触发该回调, 返回false则不触发 |

除`all`方法外, 其他方法的第二个参数均为消息处理函数

消息处理函数: `(msg: Message) => void` ([Message指路](../../objects/message.md))

### command对象

该对象用于注册指令回调, 插件可以通过该对象注册框架级指令处理

该对象有以下方法:

- `register(command: string, handler: (msg: Message | null, args: (string | number)[]) => void): Command`: 注册一个指令回调, 当指令触发时, 会触发该回调函数, 并将指令参数传入回调函数, 指令名支持携带空格

- `unregister(command: Command)`: 注销一个指令回调, 传入`register`方法的返回值即可

- `exec: (message: Message | string, args?: (string | number)[])`: 触发一个指令
  - 若第一个参数为string, 则将第二个参数作为指令参数传入, 同时目标指令回调的第一个参数会为null
  - 若第一个参数为Message, 则忽略第二个参数, 解析Message对象

指令回调函数: `(msg: Message | null, args: (string | number)[])` ([Message指路](../../objects/message.md), [Command指路](../../objects/command.md))

## 持久化存储

该上下文提供了两种数据存储方式: KV存储和文件存储, 插件可以根据需要选择合适的存储方式来保存和读取数据。

### kv对象

该存储方式自动序列化/反序列化JSON对象, 因此可以当作数据Only的简易Map对象

下列方法均为同步方法

- `init(options?: KVInitOptions)`: 初始化kv存储, 需显式调用
- `get<T>(key: string, defaultValue?: T): T`: 获取指定键的值, 如果键不存在则返回默认值
- `set(key: string, value: any)`: 设置指定键的值
- `setMany(entries: Iterable<readonly [string, unknown]>): void`: 批量设置值, 在同时写大量值时性能更优
- `delete(key: string)`: 删除指定键的值
- `has(key: string): boolean`: 检查指定键是否存在
- `clear()`: 清空所有键值对
- `clearPrefix(prefix: string)`: 删除指定前缀的键值对
- `keys(): string[]`: 获取所有键, 返回一个数组
- `entries(): [string, any][]`: 获取所有键值对, 返回一个二维数组, 每个元素为一个键值对数组
- `list<T>(prefix?: string, options?: KVListOptions): [string, T][]`
- `count(prefix?: string): number`: 获取指定前缀下的键值对数量
- `tx<T>(fn: () => T): T`: 在单次事务内指定函数, fn抛错则回滚, fn必须是同步函数, 否则better-sqlite3会在异步执行完前落盘

```ts
type KVListOptions = {
  limit?: number;  // 每次获取的极限条数
  offset?: number; // 获取偏移量
}

interface KVInitOptions {
	wal?: boolean;          // 是否启用WAL, 默认为true 
	synchronous?: "off" | "normal" | "full" | "extra";
	busyTimeout?: number;
	prepareCache?: boolean; // 是否使用预编译的SQL语句, 默认true
}
```

### fs对象

该存储方式提供了简易的文件系统读写, 以存放大数据

下列方法均为异步方法, 返回`void`的方法返回类型已省略

- `read(file: string, encoding?: string): Promise<string | Buffer>`: 读取文件. 没传encoding就返回Buffer

- `write(file: string, data: string | NodeJS.ArrayBufferView)`: 向指定文件写入数据

- `append(file: string, data: string | NodeJS.ArrayBufferView)`: 向指定文件末尾追加数据

- `exists(file: string): Promise<boolean>`: 判断指定路径上的文件是否存在

- `list(dir: string): Promise<string[]>`: 列出指定目录的所有文件/目录

- `remove(file: string, option: RmOptions)`: 删除指定文件

- `rename(file: string, newName: string)`: 重命名指定文件

- `mkdir(file: string, option: MakeDirectoryOptions)`: 创建指定目录

- `copy(from: string, to: string)`: 复制指定文件

- `stat(file: string): Promise<fs.Stats>`: 获取指定文件的属性


`fs` 的所有路径均基于插件私有存储目录(可读写)

#### 只读FS对象

如果FS API为只读, 则将只能调用以下api: `read`, `list`, `exists`, `stat`

### plugin对象

以插件代码目录为根的只读文件系统, 供插件读取自带的模板/资源等文件

提供与 `fs` 相同的读取类方法, 为[**只读FS对象**](#只读fs对象)

所有路径均基于插件代码目录

## 定时任务

### cron对象

该对象用于注册周期或一次性任务, 由框架的 Cron 调度器统一托管。

- `schedule(expression: string | Date, handler: () => void, options?: CronOptions): CronJob`: 注册一个任务, 返回任务句柄
- `jobs(): CronJob[]`: 列出**本上下文**注册的任务

`expression` 用 croner 的表达式语法, 支持 5 / 6 / 7 段(含秒时第 0 段为秒, 7 段时第 6 段为年)。常用写法:

- `"* * * * *"`: 每分钟一次
- `"0 */5 * * * *"`: 每 5 分钟一次
- `"0 0 9 * * *"`: 每天 9:00
- `"@daily"` / `"@hourly"` 等别名同样可用
- 传入 `Date` 则该任务只在对应时刻执行一次; 时刻已经过去时不会执行(不补跑)

```ts
interface PluginCronAPI {
	schedule(expression: string | Date, handler: () => void, options?: CronOptions): CronJob
	jobs(): CronJob[]
}

interface CronJob {
	name: string                          // 任务名, 全局唯一
	pause(): void                         // 暂停触发: 定时器仍在, 到点会被跳过
	resume(): void                        // 恢复触发
	stop(): void                          // 停止并出表, 之后同名任务可重新注册
	trigger(): Promise<void>              // 立即手动触发一次
	nextRun(): Date | null                // 下次运行时刻; 已停止或没有下次时为 null
	isBusy(): boolean                     // handler 当前是否仍在执行
	isStopped(): boolean                  // 是否已停止
}
```

示例:

```ts
export default {
	init(ctx) {
		ctx.cron.schedule("0 */10 * * * *", () => {
			ctx.logger.log("每 10 分钟执行一次")
		}, { name: "myPLugin-heartbeat" })

		// 一次性任务: 10 分钟后执行
		ctx.cron.schedule(new Date(Date.now() + 600_000), () => {
			ctx.logger.log("一次性任务")
		}, { name: "myPlugin-remind" })
	}
}
```

`options` 为 croner 的 `CronOptions`, 框架会在其基础上强制补上 `name` 与统一的错误出口。常用字段:

```ts
type CronOptions = {
	name?: string          // 任务名; 缺省时框架生成 8 位随机名
	protect?: boolean      // 默认 true: 上一次还在跑时跳过本次, 不并发
	paused?: boolean       // 默认 false: 是否创建后先暂停
	maxRuns?: number       // 最多执行次数; 用尽后不再触发(名字仍被占用, 需 stop() 才释放)
	startAt?: Date | string
	stopAt?: Date | string
	timezone?: string      // 如 "Asia/Shanghai", 缺省为服务器本地时区
}
```

约定:

- **任务名全局唯一**: 普通插件与服务插件共用同一个调度器, 固定 `name` 时建议带上自己的插件 id, 否则重名会直接抛异常
- 未传 `name` 时框架生成随机名, 但此时无法预测名称, 需要后续操作句柄请显式指定
- `protect` 默认为 `true`: 当一次执行还没结束、下一次已到点时, 本次会被**跳过**(不排队)。任务执行时间可能超过周期时, 请自行调小周期或显式关闭 `protect`
- handler 抛出的异常由框架统一记录到日志, **不会中断后续调度**, 也不会让进程崩溃
- handler 支持返回 Promise, 框架会等它完成(因此 `isBusy()` 与并发保护才有效)
- 表达式非法、`name` 重复或 Core 已关闭时, `schedule` 直接抛异常, 建议在 `init` 中注册以便失败时被发现
- 任务随上下文释放自动停止: 插件卸载 / 初始化失败 / 从注册表移除时, 框架停止本上下文的全部任务, 并最多等待 5 秒让运行中的 handler 收尾(超时只记警告, 不阻断卸载)
- **不要缓存 `CronJob`**: 上下文释放后句柄失效, 重新启用插件会得到新的任务实例
- 不要在 handler 里依赖已释放的资源: 卸载期间任务可能仍在跑最后一段, 此时 `ctx.kv` / `ctx.fs` 等已关闭
- 不要在单次调度任务中运行耗时代码, 避免阻塞事件循环和资源冲突

## 其他

### logger对象

该对象为框架统一使用的日志对象, 支持输出到控制台/文件/WebUI, 推荐使用该对象打印日志而不是`console`, 拥有以下方法

- `log`: 打印一条普通信息
- `warn`: 打印一条警告信息
- `error`: 打印一条错误信息
- `debug`: 打印一条调试信息

### action方法

该方法用于向适配器发送一个动作, 不过更推荐`entity.action`及其子类封装

用法: 
```ts
// entity对象来自注册的回调的参数
// action对象为具体动作信息
await ctx.action(entity, action)
```

### 插件间导入导出(exports/require)

插件可以通过 `ctx.exports` 对外暴露一组接口, 供依赖它的插件通过 `ctx.require` 导入。

导出:

- `ctx.exports = value`: 发布本插件的导出, 通常在 `init` 中同步设置
- `ctx.exports`: 读取本插件当前的导出

导入:

- `ctx.require<T = any>(pluginId: string): T`: 导入指定插件的导出, 泛型用于标注导出类型，导入的可见性仅在Bot插件内，如果需要服务插件提供的功能通过`ctx.service`访问

- `ctx.service[key]: unknown`: 获取服务插件的导出，该方法不会报错，不需要在清单中声明就可以用，没有目标就静默返回undefined

> 一般服务插件加载先于普通插件，所以只要用户启用了服务就可以获取到导出

约定:

- 被导入的插件必须在 manifest 的 `dependencies` 中声明, 框架加载时会先加载依赖, 因此依赖的导出在 `init` 中即可用
- 目标插件没有导出时(未加载/未导出/已卸载) `require` 会抛出 `StateError`, 错误信息会列出当前可导入的插件
- `require` 每次调用都实时查询, **不要缓存返回值**: 目标插件卸载后其导出即被释放, 缓存下来的只是一份失效引用
- 导出随上下文生命周期释放: 插件卸载、初始化失败、从注册表移除时都会被释放, 不会残留在框架里

示例:

```ts
// 被依赖的插件 provider
export default {
	init(ctx) {
		ctx.exports = {
			hello: () => "hi"
		}
	}
}
```

```ts
// 依赖方 consumer, manifest: { "dependencies": { "provider": "any" } }
export default {
	init(ctx) {
		const provider = ctx.require<{ hello: () => string }>("provider")
		ctx.logger.log(provider.hello())
	}
}
```

## 绝对不应触碰的禁忌

### handleMessage方法

该方法用于框架向插件分发消息

### dispose方法

该方法会销毁上下文, 仅在unload执行完后由框架主动调用, 你不应调用该方法