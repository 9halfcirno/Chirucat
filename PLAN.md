# 对象结构

## Core
持有
  - `Logger`: 记录日志
  - `BotManager`: 管理Bot实例
  - `UserManager`: 管理用户, 统一用户身份
  - `SessionManager`: 统一会话id, 使session id无关平台

### Bot
持有
  - `Logger`: 记录日志
  - `MessageHandler`: 负责处理适配器接收到的消息
  - `MessageFilter`: 负责过滤消息, 实现白名单/黑名单, 速率限制等
  - `CommandManager`: 负责处理指令消息
  - `PluginManager`: 负责管理插件, 同时参与MessageHandler的消息处理

# 流程

## 启动

### Core启动

1. 初始化数据管理

2. 读取bot目录, 并载入Bot配置

3. Core从state读取Bot的持久化状态, 并启动enable的Bot

### Bot启动

1. 初始化插件管理器, 读取插件, 并依据插件enable启动插件

2. 从config读取适配器id和配置

### Plugin启动

1. TODO: 依据清单文件递归解决依赖插件

  TODO: IF 依赖插件缺失/版本不匹配 2. 插件标记为挂起, 等待依赖解决

2. 加载模块文件

3. 依据清单声明, 初始化插件Context

4. 执行插件初始化

## 消息处理

1. 适配器插件接收到平台消息

2. 从UserManager等获取Internal Id后转为框架Message数据抽象

3. 使用ctx.bot.dispatch触发事件处理

3. 进入MessageFilter进行过滤

4. 进入CommandManager匹配指令

5. 进入插件回调

### 插件消息回调

1. 按state的顺序依次触发插件消息回调

2. 调用回调, 将期约同步抛出, 不等待