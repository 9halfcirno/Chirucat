# 适配器插件开发

适配器插件是Bot与聊天平台之间的桥梁: **收**把平台动态转成[事件](../../events/index.md)派发给Bot, **发**把框架的[Action](../../actions/index.md)转成平台接口调用。

接下来会讲述如何写出一个优秀的适配器插件, 适配器上下文见[适配器上下文](./contexts/adapter.md)

---

## 职责边界

适配器只应该做自己分内的事, 不应该越过适配器的职责, 以下是职责划分

**应该做的事**:

- **触发事件**: 接收平台消息/事件, 解析为框架的跨平台协议并触发`bot.dispatch(event)`
- **发送动作**: 处理Bot要发送的Action, 将其解析为平台认识的请求

- 也可以额外做这类事: 筛选@me消息, 过滤会话类型, 消息发送延迟等

**不应该做的事**:

- **处理业务逻辑**: 不要让适配器自带类似"关键词回复", "戳一戳回复"等业务代码

### 插件内各模块

适配器内部为了可扩展性/可维护性, 应当有一个优秀的职责边界, 让每个模块只负责分内的事

| 模块 | 职责 |
|---|---|
| 连接层 | 负责处理与平台的连接/交互等 |
| 转换层 | 负责转换平台与框架之间的数据差异, 如消息块/用户和会话id |
| 事件层 | 平台事件 -> 框架事件并派发 |
| 动作层 | Bot动作 -> 平台请求, 并返回请求结果 |
| 入口 | 负责各模块之间的协作, 初始化插件, 注册回调等 |

> 将事件/动作层模块化,有助于便捷地跟进框架协议的扩展

---

## 协议跟进

框架协议(`src/protocols/`)变动时, 适配器需要跟着改。以下是当前必须对齐的点:

### 1. 消息块收发是两套类型

`MessageBlockReceive`(收)与`MessageBlockSend`(发)是两个不同的联合类型, 不要混用:

- 事件里的`richContent`、`quote.richContent`用 **Receive**(媒体块只有`url`)
- Action里的`message`用 **Send**(媒体块的`url`与`buffer`互斥)

### 2. Buffer 发送意图

`MessageBlockSend`的媒体块允许用`buffer`代替`url`表达"本地二进制"。适配器**必须**实现它, 不能只认`url`， 平台无法使用本地文件的, 应该直接以`PARAMS_UNSUPPORTED`错误来reject本次发送

下面是框架内置的两个适配器的实现方式:

| 平台 | Buffer 的落地方式 |
| --- | --- |
| QQBot(官方) | 走分片上传: `upload_prepare` -> 逐片 `PUT` 预签名地址 -> `upload_part_finish` -> 携带 `upload_id` 调上传接口合并, 拿到 `file_info` 后以`msg_type=7`发送 |
| OneBot11 | 段里的`file`字段支持`base64://<data>`, 直接转换即可 |

### 3. 事件的必填字段

事件的`type`/`time`/`platform`以及各类型专属字段都是必填。平台给不出时**不要**塞`undefined`,
而应:

- 可选字段(如`quote`)给不出就整个不填;
- 必填字段给不出时**丢弃该事件**, 而不是派发一个残缺事件 —— 残缺事件会在下游变成难以定位的问题。

### 3.1 尽量填写 `mentionedSelf`

`message.create` 的 `mentionedSelf` 表示该消息是否 @ 了本适配器对应的 Bot, 服务插件靠它做跨适配器去重与 @ 快速通道。

- 平台只在被 @ 时推送的事件(如 QQ 的 `GROUP_AT_MESSAGE_CREATE`)直接填 `true`;
- 平台下发全量消息时, 从提及列表里判断"是否提到了自己":
  QQBot 看 `mentions[].is_you === true`, OneBot11 把 `self_id` 换算成框架账号 uuid 后与 `mention` 段比对;
- 私聊没有 @ 语义, 填 `false`;
- 平台根本给不出 @ 信息时可以整个不填: 下游会当作"未知", 而不是"确定没 @"。

### 3.2 剥离消息开头的 @Bot

指令系统按 `text` 的前缀匹配指令名。收到 "@Bot /命令" 时, 如果适配器把 @Bot 留在 `text` 里
(例如 OneBot11 直接渲染成 `@<uuid> /命令`), 消息就永远命中不了指令。

- 平台把 @Bot 作为独立消息元素下发时, 应在构造事件前删掉**开头那一个**, 再据此生成 `text` 与 `richContent`;
- 只剥离开头的 @Bot: 消息中段 @ 别人属于内容, 必须保留;
- `mentionedSelf` 用剥离前的原始信息判定。

### 4. 平台标识必须经过转换

`senderId`/`sessionId`/`operatorId`一律通过`ctx.user.get`与`ctx.session.get`转换成框架id,
**不能**直接填平台原始id。这是跨平台数据绑定的前提。

### 5. Action 处理器必须返回响应

动作已被框架按`meta.adapter`路由到你的适配器, "不归我管"不是合法状态:

- 返回`undefined`会被框架记为`ADAPTER_UNHANDLED`, 调用方只看到一个没有原因的失败;
- 平台不匹配、会话解析不到、会话类型不支持都要返回**带`error`与`code`的失败响应**;
- 处理器抛出的异常也要在分发层兜成失败响应, 否则`msg.reply()`会以未捕获异常收场。

### 6. 传播型事件也要如实派发

`message.delete`这类事件当前框架尚未完善和创建实体([处理程度](../../events/index.md#各事件的处理程度)),
但服务插件的过滤器与观察者能看到它。适配器应如实派发, 不要因为"现在没人处理"就省略。

---

## 让新增能力只改一处

平台协议会持续加事件/动作/消息段。推荐把这三种分派都做成**表驱动**, 新增一项就是加一行:

```
events.ts    MESSAGE_ROUTES / RECALL_ROUTES   平台事件类型 -> 构建规则
codec.ts     段/块 双向往返                    新的消息段类型 -> 一个 case
actions.ts   QQ_ACTIONS / OB11_ACTIONS         动作类型 -> 处理器
```

两个额外技巧:

- **用映射类型强制穷尽**。把处理器表声明为
  `{ [K in BotActions["type"]]: Handler<K> }`, 框架新增Action类型时这里会因"少一个键"而编译失败,
  不会出现"新增了动作但没人处理"的静默缺陷。
- **把纯逻辑与IO分开**。编解码与事件映射保持在纯函数形态(平台标识转换用参数注入),
  连接与请求封装进类。这样纯逻辑可以被自检脚本直接覆盖, 不必起连接。

### 状态放哪

**不要用模块级全局变量堆连接状态**。`ws`/`seq`/`session`/各类定时器是一份完整的生命周期状态,
把它们收进一个连接类里, 就能整体创建/销毁, `stop()`之后不留残余定时器, 也便于将来做多分片或同时管多连接。

模块级只保留**一个**实例引用(供`init`/`unload`成对使用):

```ts
let adapter: MyAdapter | null = null;

export default {
	init(ctx) { adapter = new MyAdapter(ctx); adapter.start(); },
	unload() { adapter?.stop(); adapter = null; }
};
```

### 资源回收

适配器常持有定时器与长连接, 必须在`unload`里显式释放(框架只能回收`ctx`上的副作用, 管不到这些):

- 清掉心跳/重连/超时定时器
- 派发前先解绑`socket`的`onclose`等回调, 否则"主动关闭"会被当成"断线"而触发重连
- 拒绝所有在途请求, 避免卸载后还有Promise悬着

---

## 参考实现

两个自带适配器就是按上面的结构组织的, 新增适配器可以直接照搬:

### QQ适配器(官方QQBot开放平台)

```
plugins/qq-adapter/
├── index.ts        入口: 装配 + 生命周期
├── config.ts       常量(接口地址、file_type、超时)
├── types.ts        平台原始数据结构
├── access.ts       AccessToken 管理(含并发合并与预刷新)
├── connection.ts   QQConnection: 握手/心跳/Resume/重连
├── api.ts          QQApi: HTTP 封装
├── uploader.ts     MediaUploader: URL 上传 + 分片上传
├── codec.ts        content <-> 消息块
├── events.ts       事件路由表 + 事件构造
└── actions.ts      动作注册表 + 处理器
```

### OneBot11适配器

```
plugins/onebot11-adapter/
├── index.ts        入口: 装配 + 生命周期
├── constants.ts    常量(PLATFORM 固定为 qq, 见文件内说明)
├── types.ts        平台原始数据结构
├── connection.ts   Ob11Connection: 正向 WS + echo 请求配对
├── codec.ts        段数组/CQ码 <-> 消息块(base64 承载 Buffer)
├── events.ts       message.create / message.delete 构造与过滤
├── filters.ts      内容过滤规则(含正则缓存)
├── identity.ts     平台用户id -> 昵称缓存
└── actions.ts      动作注册表 + 处理器
```

---

## 自检

改动适配器后跑这三条:

```bash
npm run check:plugins    # 适配器类型检查(含协议类型对齐)
npm run check:adapters   # 编解码/事件/动作语义 + 用 PluginLoader 真实打包入口
npm run check:types      # 框架自身类型检查
```

`check:adapters`覆盖纯函数语义, 并用框架自己的`PluginLoader`把入口真的构建一遍,
能抓到"入口路径写错"和"导入了被拒绝的内置模块"这类只在加载时才暴露的问题。

> 适配器接的是真实平台, 自检替代不了联调: 新增的平台接口请务必在真实环境验证一次。
