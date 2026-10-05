# 适配器插件开发

适配器插件是Bot与聊天平台之间的桥梁: **收**把平台动态转成[事件](../../events/index.md)派发给Bot, **发**把框架的[Action](../../actions/index.md)转成平台接口调用。

本文讲"怎么把适配器写得可维护、可扩展", 上下文能力本身见[适配器上下文](../contexts/adapter.md)。

---

## 职责边界

| 模块 | 该做什么 | 不该做什么 |
| --- | --- | --- |
| 连接层 | 握手/鉴权、心跳保活、断线重连、请求-响应配对 | 解析业务字段 |
| 编解码层 | 平台消息格式与[`MessageBlock`](../../objects/message.md#messageblock对象)互转 | 读写连接、发请求 |
| 事件层 | 平台事件 -> 框架事件的字段映射与过滤 | 发起网络请求 |
| 动作层 | 框架Action -> 平台接口调用 | 维护连接状态 |
| 入口 | 装配上述模块、注册回调、管生命周期 | 堆业务逻辑 |

**入口文件应该很薄**。如果入口里出现了"连接细节"或"字段拼装", 说明这段逻辑该挪进对应模块。

---

## 协议跟进清单

框架协议(`src/protocols/`)变动时, 适配器需要跟着改。以下是当前必须对齐的点:

### 1. 消息块收发是两套类型

`MessageBlockReceive`(收)与`MessageBlockSend`(发)是两个不同的联合类型, 不要混用:

- 事件里的`richContent`、`quote.richContent`用 **Receive**(媒体块只有`url`)
- Action里的`message`用 **Send**(媒体块的`url`与`buffer`互斥)

> 历史坑: 早期只有一个`MessageBlock`类型, 收发共用。协议拆分后仍引用旧名字的代码不会报错(类型被擦除),
> 但用错方向会编译期失守 —— 这就是需要 `npm run check:plugins` 的原因。

### 2. Buffer 发送意图

`MessageBlockSend`的媒体块允许用`buffer`代替`url`表达"本地二进制"。适配器**必须**实现它, 不能只认`url`
(只认`url`的表现是: 插件发了带`buffer`的图片, 消息静默少一段)。

| 平台 | Buffer 的落地方式 |
| --- | --- |
| QQBot(官方) | 走分片上传: `upload_prepare` -> 逐片 `PUT` 预签名地址 -> `upload_part_finish` -> 携带 `upload_id` 调上传接口合并, 拿到 `file_info` 后以`msg_type=7`发送 |
| OneBot11 | 段里的`file`字段支持`base64://<data>`, 直接转换即可 |

分片上传有两个容易写错的地方:

- **分片偏移不能自己假设**。分片大小由服务端下发的 `parts[].block_size` 决定, 偏移要按前序分片累加;
- **每片 PUT 成功后必须调一次分片完成接口**, 否则合并会失败。

### 3. 事件的必填字段

事件的`type`/`time`/`platform`以及各类型专属字段都是必填。平台给不出时**不要**塞`undefined`,
而应:

- 可选字段(如`quote`)给不出就整个不填;
- 必填字段给不出时**丢弃该事件**, 而不是派发一个残缺事件 —— 残缺事件会在下游变成难以定位的问题。

### 4. 平台标识必须经过转换

`senderId`/`sessionId`/`operatorId`一律通过`ctx.user.get`与`ctx.session.get`转换成框架id,
**不能**直接填平台原始id。这是跨平台数据绑定的前提。

### 5. Action 处理器必须返回响应

动作已被框架按`meta.adapter`路由到你的适配器, "不归我管"不是合法状态:

- 返回`undefined`会被框架记为`ACTION_NOT_HANDLED`, 调用方只看到一个没有原因的失败;
- 平台不匹配、会话解析不到、会话类型不支持都要返回**带`error`的失败响应**;
- 处理器抛出的异常也要在分发层兜成失败响应, 否则`msg.reply()`会以未捕获异常收场。

### 6. 传播型事件也要如实派发

`message.delete`这类事件当前框架尚未创建实体([处理程度](../../events/index.md#各事件的处理程度)),
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
