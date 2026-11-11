# Bot

## 概述

框架在社交平台上的身份, 从代码层面看即包含一组插件的独立容器

## 核心属性

- **ID**: 即Bot的标识符, 框架用此区分不同Bot

- **Name**: 即Bot的名称, 便于分辨, 不一定是IM平台账号昵称

## 组成部分

### 插件

即为Bot提供能力的组件, 初始Bot只有少量框架提供的功能, 需要插件来扩展Bot能力

### 适配器

即将Bot接入具体IM平台的插件, 使Bot真实可交互

## 状态管理

Bot 同时持有**运行态**与**持久化期望态**, 两者刻意分开(`src/bot/bot.ts:22-24`):

| | 运行态 | 期望态 |
| --- | --- | --- |
| 内容 | `Bot.running`、每个插件的 `status` | `state.json` 里的 `enable` 与 `enabledPlugins` |
| 位置 | 只在内存, 进程退出即消失 | 磁盘 `<Bot目录>/state.json` |
| 谁写 | 宿主(启停/收敛) | WebUI 操作、手工编辑文件 |
| 方向 | 从期望态**收敛**过来 | 永不由运行态回写 |

运行态不回写期望态, 否则"收敛运行态"会反过来污染用户偏好: 停一次 Bot 不等于"以后都别启动"。

### 两套持久化数据别混

- `<Bot目录>/config.json` —— Bot 的**设置域**(`bot:<id>`), 放身份与展示(名称), 走 `POST /api/bot/config/get` / `bot/config/update`(`bot.settings.patch`)。`id` 是 `immutable`, 且默认值是空串, 所以这个域的值文件损坏时**抛错跳过该 Bot**, 不像框架域那样按默认值重建 —— 重建会造出一个身份不明的 Bot(`src/bot/bot.ts:70-79`)。
- `<Bot目录>/state.json` —— **期望启停态**, 走 `bot/get` / `bot/state/update` / `bot/plugin/state/update`。
- `<Bot目录>/configs/plugins/<插件id>.json` —— 插件的**配置值**(控件定义来自插件自带的 manifest.config)。它不做文件监听, 手工编辑需重启插件或重新载入(见 [设置域文档](../schemas/settings.md))。
- 插件实际的 `status`、`module`、`context` 只在内存, 由 `PluginManager` 维护。

### `state.json`: opt-in 白名单

```json
{
  "enable": true,
  "enabledPlugins": ["some-plugin"]
}
```

默认 `{ enable: false, enabledPlugins: [] }`; **只有登记过的插件才会被启用**(`src/bot/state-manager.ts:5,61-63`)。旧格式 `plugins: { "<id>": true }` 仍可读, 写回时统一成新结构(`:28-46`)。名单顺序敏感 —— `isSameState` 逐位比较, 不重排(`:15-20`)。

服务插件正好相反: `configs/services/state.json` 是 **opt-out 黑名单** `{ "disabledServices": [...] }`, 默认全部启用, 新装的服务插件无需登记即可用(`src/plugin/services/state.ts:3-19`)。两种语义是两份显式分开的策略, 不是布尔开关切出来的(见下节)。

### 存储分层

```
JsonFileStore           原子写 / 串行队列 / revision 守卫 / 外部监听
  └─ DesiredStateStore  期望态基类: 形状策略 + 变更判定 + commit
       ├─ BotStateManager      botStateStrategy     (白名单 + 旧格式兼容)
       └─ ServiceStateManager  serviceStateStrategy (黑名单 + 依赖连带)
```

`DesiredStateStrategy<T>` 只有三个成员: `defaults` / `normalize` / `equals`(`src/config/desired-state-store.ts:11-18`)。三条共通契约固定在基类(`:26-33`): 写入一律经 `commit` 且落盘完成才 resolve; 状态文件按需创建(缺失表示"从未写过", 不主动添文件); `startWatching()` 后外部改动会重读并通知, 自身写入不触发。

设置域、`ConfigManager` 与这两个 StateManager 共用 `JsonFileStore` 作为落盘底座, 但**容错语义不同**: 设置域损坏时备份重建、状态文件回落默认、ConfigManager 语法错误照常抛出。

### 期望态如何收敛到运行态

| 触发 | 路径 |
| --- | --- |
| Core 启动 / BotManager 批量 | `Bot.syncState()` → `state.load()` → `applyDesired()` → `converge()`(`src/bot/bot.ts:258-261, 234-253`) |
| `Bot.start()` | 扫描插件 → `plugin.syncState()` 按白名单加载 → `dropUnstartable()` 清理起不来的 id(`:116-130`) |
| WebUI 开关 | `setEnable` / `setPluginEnabled` **先加载或卸载成功, 再写入期望态**(`:153-175`); 两侧的 `setEnabled` 都按依赖连带一并落盘 —— 停用把被连带卸载的依赖者一起移出白名单, 服务侧则是写进黑名单 |
| 手工编辑 `state.json` | `initState()` 注册 `state.watch` → `applyDesired()`(`:93-107`), 与 WebUI 操作排进同一条串行队列 |
| 服务插件目录刷新 | `ServiceHost.scan()` + `syncState()`; 期望名单在**串行队列内部**求解, 避免把排队期间的 `setEnabled` 反向拉回 |

所有会改变运行态的操作都过 `Bot.serialize` / `ServiceHost.serialize`, 防止"刚启动又被停掉"这类交错竞争(`src/bot/bot.ts:216-231`)。收敛失败的插件由 `dropUnstartable` 从期望名单移除(`:185-190`): 文件里不该留一条做不到的期望。

`PluginManager.syncState` 与 `ServiceHost.convergeState` 的共通流程是"**先卸后装 + 逐项容错 + failed[]**", 抽在 `ManagedHostBase` 里; 期望名单在哪里求解仍由两个宿主自己决定(见 [服务插件文档](../plugin/service.md))。

### WebUI 看到的是什么

WebUI 只拿到**运行态**: `PluginPayload` 是 `{ running, plugins: { global, bot } }`, `ServicePayload` 是 `{ plugins: [...] }`(形状刻意不同, 前端分别消费)。期望态不往前端漏, 因此不会出现"文件说开着、界面说关着"(`src/webui/server/plugin-view.ts:48-58`)。`registered` / `disabled` 都收敛成 `disabled`, 切换中显示 `loading` / `unloading`。

服务侧的开关会回传**完整列表**与 `affected`, 前端整块重绘。插件侧刻意不回完整列表: `bot/plugin/state/update` 只回 `state` 与 `affected`, 直接取宿主 `PluginManager.setEnabled` 的回报 —— 那批 id 就是它写进 `state.json` 的同一批, 界面与文件不会各说各话, 也不必在端点前后各取一次快照。前端按 id 找到关联卡片, 同步徽章与开关(含 `dot-switch` 的内部状态闭包)逐个对齐; 请求失败时改用只读的 `bot/plugin/list` 把可能已跑了一半的连带状态拉回界面。

> 白名单只登记**用户自己决定要开**的插件: 启用一个插件时它依赖的插件是被隐式拉起的, 不进 `enabledPlugins`。但停用方向的连带**必须落盘** —— 只写目标自身一个 id 时, 重启后仍在白名单里的依赖者会沿 `load` 的递归把整棵依赖树重新拉起, 用户只能从叶子往上逐个关才关得干净。因此停用会把被连带卸载的依赖者一并移出名单(`src/plugin/manager.ts` 的 `setEnabled`), 这与服务插件把连带结果一并写进黑名单是同一口径, 差别只剩 opt-in / opt-out 的写法。
