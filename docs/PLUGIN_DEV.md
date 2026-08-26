# 插件开发指南

面向为 Chirucat 开发插件 / 适配器的开发者。本文档假设你熟悉 TypeScript / JavaScript。

## 插件是什么

插件由两部分组成：

- **`manifest.json`**：插件清单，声明插件 ID、版本、入口文件等
- **入口模块**：默认导出一个 `{ init(ctx), unload?() }` 对象

插件分两种类型：

| 类型 | 用途 | 注入的上下文 |
| --- | --- | --- |
| `adapter` | 接入聊天平台的适配器插件 | `AdapterContext` |
| `normal`（默认） | 处理消息、注册指令的普通插件 | `PluginContext` |

插件加载顺序：先扫描全局 `plugins/`，再扫描 Bot 私有 `plugins/`，**后者覆盖前者**的同名插件。

## manifest.json

```json
{
  "id": "ping",
  "version": "0.0.0",
  "name": "Ping",
  "author": "9halfcirno",
  "main": "index.ts",
  "type": "normal"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 插件唯一 ID |
| `version` | ✅ | 插件版本 |
| `main` | ✅ | 入口文件路径（`.ts` / `.js`） |
| `type` | | `adapter` 或 `normal`，默认 `normal` |
| `name` / `author` / `description` | | 展示信息 |
| `dependencies` | | 插件依赖声明（规划中，暂未解析） |

## 普通插件

入口模块默认导出 `{ init(ctx), unload?() }`：

```ts
import type { PluginContext } from "../../src/plugin/contexts/context";

export default {
  init(ctx: PluginContext) {
    // 前缀匹配：消息以 "ping" 开头时回复 "pong"
    ctx.message.start("ping", (msg) => {
      msg.reply("pong");
    });
  },
};
```

### 消息匹配 API（`ctx.message`）

回调按注册顺序依次匹配，错误不阻断后续回调：

| 方法 | 匹配方式 |
| --- | --- |
| `all(handler)` | 接收所有消息 |
| `full(text, handler)` | 全词匹配 |
| `start(prefix, handler)` | 前缀匹配 |
| `end(postfix, handler)` | 后缀匹配 |
| `includes(text, handler)` | 包含匹配 |
| `regex(regexp, handler)` | 正则匹配 |
| `match(predicate, handler)` | 自定义谓词匹配 |

回调接收框架 `Message` 实体，常用成员：

- `msg.text`：消息文本
- `msg.sender`：发送者 `{ id, name }`（内部统一 ID）
- `msg.session`：会话 `{ id, type }`（内部统一 ID）
- `msg.reply(text | blocks)`：向当前会话回复消息

### 指令 API（`ctx.command`）

```ts
const command = ctx.command.register("help", (msg, args) => {
  // args 为解析后的参数数组（数字参数自动转为 number）
});
ctx.command.unregister(command);
```

指令默认前缀为 `/`。只有未匹配到指令的消息才会进入插件消息回调。

## 适配器插件

适配器负责把平台事件转换为框架事件，并处理框架下发的动作：

```ts
import type { AdapterContext } from "../../src/plugin/contexts/adapter-context";

export default {
  async init(ctx: AdapterContext) {
    // 收到平台消息时，派发为框架事件
    ctx.bot.dispatch({
      type: "message.create",
      senderId: ctx.user.get("example", platformUserId),
      sessionId: ctx.session.get("example", "group", platformGroupId),
      sessionType: "group",
      text: "...",
      time: Date.now(),
      platform: "example",
    });

    // 处理框架动作（如发消息）
    ctx.bot.onAction((action, extra) => {
      if (action.type === "message.send") {
        // 调用平台 API 发送消息；extra 携带事件附加数据（如 msg_id）
      }
    });
  },

  async unload() {
    // 清理连接与定时器
  },
};
```

适配器上下文（`AdapterContext`）在普通插件上下文基础上额外提供：

- `ctx.bot.dispatch(event)`：派发平台事件（`BotEvents`）
- `ctx.bot.onAction(handler)`：注册动作处理器（`BotActions`）
- `ctx.user.get(platform, id)` / `ctx.user.query(uuid)`：统一用户 ID 映射
- `ctx.session.get(platform, type, id)` / `ctx.session.query(uuid)`：统一会话 ID 映射

## 事件与动作协议

| 类别 | 类型 | 说明 |
| --- | --- | --- |
| 事件 `BotEvents` | `message.create` | 平台新消息（含 `text`、`richContent`、发送者、会话、附加数据） |
| 动作 `BotActions` | `message.send` | 向某会话发送消息（含会话 ID、消息内容） |

`Message` 的 `reply()` 即发送 `message.send` 动作，框架会将其路由给产生该事件的适配器。

## 消息处理流程

1. 适配器收到平台消息，通过 `ctx.bot.dispatch` 派发 `message.create` 事件
2. 框架将事件包装为 `Message` 实体
3. `MessageHandler` 处理：`MessageFilter` 过滤（被阻止则丢弃）→ 指令匹配（命中则执行指令，未命中才进入插件回调）
4. 插件通过 `msg.reply(...)` 触发动作，由对应适配器发送到平台
