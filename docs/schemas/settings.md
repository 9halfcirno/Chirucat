# 设置 (Settings)

面向**框架自身**的可变配置: WebUI 端口与密码、Core 模块开关、统计参数 ...
它就是一份 [Config Schema](./config.md) —— 与插件配置同一套控件、同一个存储引擎,
差别只在**写入策略**: 框架设置的写入是"校验 + 落盘"原子的, 并多出脱敏、热应用与
首次生成这些策略。

## 与插件配置的关系

同一个引擎 `ConfigBase` (`src/config/base.ts`) 负责: 默认值展开、宽松 `coerce`
(补默认/丢未知键/数字规范化)、逐字段变更通知、文件绑定与载入。
两个子类只差策略:

| | 插件配置 `ConfigManager` | 框架设置 `SettingsDomain` |
| --- | --- | --- |
| 写入 | 宽松合并, 校验由 API 层另调 `validate()` | 严格 patch: 校验 + 写盘原子, 未知键拒绝 |
| 读取 | 原样 | `secret` 字段脱敏 |
| 语义标记 | 解析但不消费 | `restart` / `immutable` 生效 |
| 写入后 | 触发 `watch` | 调 `apply(values, changed)` |
| 载入 | 缺失按默认建; 语法错误抛出 | 缺失按 `onCreate` 建; 损坏备份重建 |

值文件的容错语义由传给 `JsonFileStore` 的选项显式给出(抛出 / 回落 / 备份重建),
不把这几种混成一种。

**两者都不监听值文件的外部改动**: Bot / 服务期望态文件靠 store 的监听收敛启停,
而设置与插件配置几乎都经 WebUI/API 写入; 每份配置挂一个目录 `fs.watch`, 在几十上百个
插件同时启用时句柄数与事件唤醒会成倍放大。手工编辑值文件需重启(或显式 `load()`)才生效。

## 加一个设置项

只改 schema; 存储、接口、前端都不用动:

```ts
export const webuiSettings: ConfigRoot = {
	version: "1.0.0",
	controls: [
		{
			type: "input", id: "port", label: "监听端口",
			default: 7636, valueType: "number", min: 1, max: 65535, integer: true,
		},
		{
			type: "group", id: "frontConfig", label: "前端", controls: [
				{ type: "switch", id: "enableTestLab", label: "测试实验室", default: false },
			],
		},
	],
};
```

- 控件类型与字段见 [Config Schema](./config.md); 嵌套分组用 `group`。
- 数值输入用 `input` + `valueType: "number"`(前端是文本框 + 数字键盘提示, 后端转数字);
  有完整范围的用 `slider`。
- `SettingsManager.register()` 会在启动时检查 schema: 重复 id、缺 id、`table` 立刻抛错
  (框架设置不支持 table —— 整表替换没有对应的严格写入入口)。类型与语义标记由
  TypeScript 在域定义处保证。
- `select` 请显式写 `default`: 共享引擎的缺省值是空串, 而不是首项。

## 加一个设置域

```ts
const domain = core.settings.register<WebUISettings>("webui", {
	schema: webuiSettings,
	file: WEBUI_SETTINGS_FILE,
	apply: (values, changed) => { /* 只需重启的字段不会进来 */ },
});
await domain.load();
```

- `apply` 在**落盘成功后**调用, 只收到本次真正变化的字段, 且已剔除 `restart` 字段 ——
  需要重启才生效的项在运行期没有意义, 机制上不让它进热应用。载入完成时也会调用一次
  (`changed` 为空数组), 用于把值同步给运行中的对象。
- `apply` 抛错不回滚已落盘的值, 而是抛 `SettingsApplyError`(其 `outcome` 已脱敏),
  消息是"已保存, 但热应用失败"。
- 值文件缺失时按 `onCreate`(缺省取 schema 默认值)生成; 内容损坏时先把原文件改名为
  `<文件>.broken-<时间戳>-<随机>` 备份, 再按同样的默认值重建一份 —— 既不静默跳过、
  也不阻断启动。`load()` 返回 `{ values, created, recovered, backupFile? }` 供启动层
  打印初始密码或告警; schema 文件本身不掺日志逻辑。
  `get()` 取当前值(明文, 内部通道), `settings/get` 走的是脱敏后的 `read()`。
- 读盘时语义非法的单个字段会**回落到默认值**, 而不是让整个域起不来; 语法错误才按
  `onError` 处理(`recreate` / `fallback` / `throw`)。

## 启动参数也来自设置域

`app.ts` 不读任何配置文件: `startCore()` 只 `new Core(options)` 再 `init()`。
`Core.initSettings()` 装配四个内置域并 `loadAll()`, 随后 `resolveStartupSettings()`
从 `core` 域取模块开关、从 `webui` 域取 `WebUIServer` 的构造参数、从 `statistics`
域取统计参数 —— 启动期与运行期共用同一份值文件, 没有第二套读写路径。

- `CoreOption` 不再是配置来源, 只保留测试/嵌入式的**显式覆盖**(关掉 WebUI 与统计、
  把服务状态文件指到临时目录), 优先级高于设置域。
- `loadAll()` 汇总每个域的 `created` / `recovered`: 前者让启动层打印 WebUI 首次生成的
  随机密码, 后者让启动层提示值文件被重建及备份位置。
- 域定义(`domains/*.ts`)只描述数据形状、默认值与首次生成工厂, 保持彼此一致、不写日志。

## 内置的域

- **`core`** (`configs/core.json`): `webui`(只读 —— 关掉就再也进不来)、`statistics` 模块开关(热生效: 开着就建、关了就关, 统计页同时从活动栏增删)
- **`webui`** (`configs/webui.json`): 密码 / 监听端口 / 监听地址 / 本机免密 / `frontConfig`(测试页随开关增删) —— 全部热生效
- **`statistics`** (`configs/statistics.json`): 冲刷间隔、缓冲条数、两级保留天数(全部热生效)
- **`logging`** (`configs/logging.json`): 日志级别(枚举, **热生效** —— 保存即改 `Logger` 的最低级别)
- **`bot:<id>`**: 每个 Bot 各自一份, 见下

## 每 Bot 的设置域

Bot 设置不进 `core.settings`, 而是挂在 `Bot` 自己身上 (`bot.settings`, 定义在
`src/config/settings/domains/bot.ts`): 域的数量与生命周期跟随 Bot, 也不该出现在
WebUI 的全局设置列表里。值文件是 `<Bot目录>/config.json` —— 与 `BotManager.scan`
读的是同一份, 不迁移文件名。

- **`id` 标了 `immutable`**: 它同时是目录名、`BotManager.bots` 的 Map 键与插件配置
  路径的基准 (`ConfigManager.fileForPlugin(bot.path, ...)`)。改名是一次专门的迁移,
  不能藏在"保存设置"里 —— 提交不同的 id 直接 400。
- **与 `state.json` 的边界**: 设置只放用户意图(身份与展示), 期望启停态
  (`enable` / `enabledPlugins`) 留在 `state.json`。
- **损坏值文件不重建**: `bot:<id>` 域显式用 `onError: "throw"` —— `id` 的默认值是
  空串, 又同时是目录名与索引键, 按默认值重建会造出身份不明的 Bot。框架自身的
  四个域才备份并按默认值重建。
- **接口**: `POST /api/bot/config/get { bot }` 与 `POST /api/bot/config/update { bot, patch }`,
  返回形状与全局设置域一致, 前端复用同一套渲染。

> 值文件按 schema 白名单规范化, schema 之外的键会在下一次写入时被丢弃 ——
> `config.json` 里出现的字段必须都写进 schema。

## 语义标记

- **`secret`** (仅 `input`): 对外读取(`read()`)一律脱敏为空串,
  patch 里**空串表示不修改**、**null 表示清除**(回落默认值)。
  `get()` 是明文内部通道, 不得把它的值写进日志或任何外流结构。
  插件配置**不脱敏** —— 插件自己需要明文。
- **`restart`**: 改动会落盘, 但不进 `apply`, 且出现在接口返回的 `restartRequired` 里,
  前端据此提示"需重启 Core 后生效"。
  **当前内置的域没有用到它** —— 能热的都做成热的了 (`WebUIServer.relisten` 换监听、
  `updateSecurity` 换密码与免密、`StatisticsManager.updateOptions` 改统计参数);
  机制保留给将来真正无法热更的项(如数据库路径)。
- **`immutable`**: 设置接口(patch)不接受把它改成别的值; 提交等值不算改动。
  它**只约束 patch** —— 手工编辑值文件仍会让新值生效(与 `state.json` 的处理一致)。
  只声明在 input / textarea / switch / slider 上: 自绘下拉没有原生 disabled,
  给它加这个标记只会变成"看起来能改、后端拒绝"的假只读。
- **`valueType: "number"`** (仅 `input`): 后端把数字字符串规范化为数字, 校验要求
  可解析为数字并满足 `integer` / `min` / `max`。前端仍是文本框 + 数字键盘提示;
  需要滑块时用 `slider` 控件。

## 接口

- `GET /api/settings/get` → `{ domains: [{ id, define, values }] }`

  `define` 是 **`ConfigRoot`** (`{ controls: [...] }`), 与 `bot/plugin/config/get` 一致 —— 前端
  `createConfigList` 读的就是 `define.controls`, 传裸数组会渲染成空表单 (表现为"一个设置项
  都没有")。`values` 已脱敏。
- `POST /api/settings/update` `{ domain, patch }` → `{ values, changed, restartRequired }`
  字段级校验失败返回 400 + `details`; 未知域 404; WebUI 脱离 Core 时 503。

两者都声明 `auth: true`, 走与其它管理接口相同的鉴权。

## 前端

`src/webui/public/js/pages/settings/settings.js` 只做两件事: 拉快照 → **按域生成二级侧栏**
(每个域一项, 点哪项就渲染哪个域的表单) → 每份表单用 `createConfigList(define)` 渲染 →
提交 `getValues()`。

侧栏项是在 `render()` 里动态写 `this.sidebar` 得到的 —— framework 的导航顺序是
先 `await page.render(view)`, 之后才 `await renderSideBar(page, view)`, 所以异步拉到的
域列表来得及变成菜单。除此之外框架还提供运行期增删菜单的 `app.sidebar.*` 接口
(见 [WebUI 前端 SPA](../webui/spa.md))。

**不要在页面里硬编码设置项, 也不要在前端维护域名单** —— 后端加一个域, 侧栏就多一项。
提交整份 `getValues()` 而不是自己算差集: 后端按 patch 语义合并, 未提交的字段保留原值。

两处特例需要前端配合(它们会断掉当前连接或让会话失效):

- 改**监听端口**: 保存后本地会跳到新地址 (`location.hostname:<新端口>`)
- 改**访问密码**: 所有会话立即失效, 提示重新登录

## 自检

```
npm run check:settings   # schema 校验/默认值/patch/落盘/并发/竞态 + 接口层端到端
npm run check:startup    # 启动装配: created / recovered / 注入覆盖 / 服务钩子
npm run check:baseline   # 状态管理重构前的行为基线 (三个脚本串联)
npm run check:desired-state  # 期望态泛型基类
npm run check:managed-host   # 泛型插件宿主基类 (探针宿主, 36 项)
npm run check:value-tools    # 唯一一份 deepEqual / 值工具语义 (17 项)
npm run check:webui-config   # WebUI 配置端点与视图的返回形状、插件开关联动 (32 项)
```

这些自检都全程使用系统临时目录。接口层自检走真实 Core 与真实 handler, 但把域指向临时文件, 并比对
`configs/webui.json` 的哈希以自证没碰仓库里的配置。
`check:startup` 另外验证: 首次生成带随机密码、损坏值文件被备份并按默认值重建、
启动参数确实取自设置域、`app.ts` 不再自己读配置、以及 `before.service.enable` 的取消语义。

`check:baseline` 是重构 `Bot` / 插件状态管理之前的**行为基线**, 不改任何生产代码:

- `check:plugin-manager` —— 扫描对账(service 跳过 / bot 私有优先 / 悬空清理 / 实例复用)、
  依赖环与缺失依赖预检、服务依赖豁免、递归加载顺序、`load`/`unload` 幂等、Hook 取消、
  加载失败回滚、`syncState` 先卸后装与 `failed[]`, 以及配置值文件不做外部监听
- `check:config-manager` —— 默认值展开、白名单规范化、group/table 的 coerce、
  `update` 保留未提交字段、逐字段监听、并发写不交错、`updateSchema`; 并专门钉住
  **值文件语法错误是抛出的**(与设置域"备份后重建"的语义不同)、**`data` 是只读视图**、
  以及**手工编辑值文件不自动生效**(刻意不做文件监听, 只有显式 `load()` 才重读)
- `check:entity-state` —— `Plugin` 与 `Service` 的 enable/disable 状态机(幂等、冲突拒绝、
  init/unload 抛错时的清理与终态分工), 并断言两类实体逐条同构 —— 这是把它们合成泛型实体的前提

后续每批改完重跑这一组, 红了就能定位到是这次合并改坏了哪条既有行为。

`DesiredStateStore`(`src/config/desired-state-store.ts`) 是第 1 批抽出的期望态基类,
另有 `npm run check:desired-state` 直接验它: 策略注入(`defaults`/`normalize`/`equals`)、
文件缺失不创建、损坏回落默认、名单顺序敏感, 以及 Bot 的 opt-in 白名单与服务的
opt-out 黑名单确实是两份显式分开的策略(不是布尔开关切出来的两种行为)。

第 2 批把 `ConfigManager` 真正接上了 `JsonFileStore`: `data` 现在是**只读视图**(深拷贝),
写入一律走 `update()` / `save()`, 并享受原子写与串行化落盘。值文件**不做外部监听**:
宿主不在 `enable` 时启动 `fs.watch`, `disable` 时也无需关闭 —— 这是针对大量插件同时
启用的性能取舍; 手工编辑配置须显式 `load()` 或重启插件。

第 3 批把 `Plugin`/`Service` 合流到 `ManagedEntity`(`src/plugin/managed-entity.ts`)、
把 `PluginManager`/`ServiceHost` 合流到 `ManagedHostBase`(`src/plugin/managed-host.ts`)。
两个子类只剩差异策略与各自的编排层: 服务宿保留期望态/串行队列/释放流程,
插件宿保留双目录扫描与适配器动作派发; 启停的依赖连带两侧都有(`ServiceHost.setEnabled` 与
`PluginManager.setEnabled` 共用基类的图遍历), 差别只在把连带结果写进黑名单还是移出白名单。
`npm run check:managed-host` 用探针宿主直接验
基类契约(36 项): 双表迭代与查找顺序、依赖图(缺失/豁免/环/按序)、load 调用链与失败回滚、
Hook 取消、递归卸载、`convergeState` 先卸后装与 `failed[]`、扫描对账、配置装配与事件派发。

实体层还有一处顺手修正: `error` 钩子自身抛错时, 日志原本在普通插件里打的是最初的
init 错误(内层 catch 未绑定), 服务插件里打的是钩子错误。合并后统一打钩子错误 ——
"错误清理失败"这条日志的主语本来就是钩子。`check:entity-state` 的 49 项断言不受影响。

第 4 批收尾把两份语义不一致的 `deepEqual` 收敛到 `src/config/store.ts` 唯一一份
(JSON 值专用: 数组顺序敏感、数组与对象不相等、键名要对得上; `src/utils/deepEqual.ts`
已删除), `npm run check:value-tools` 直接验这些边界并防止旧实现被重新引入。
WebUI 侧把四个配置端点的"按需装配 + 404"薄壳收敛到 `_shared.requirePluginConfig`,
两个 view 的字段映射收敛到 `plugin-view.toManagedView`; **返回结构刻意不对称**
(插件分组对象 / 服务数组、服务 `affected` 与完整列表、hasConfig 口径)全部保留,
由 `npm run check:webui-config` 逐条钉住。状态管理的整体说明见 [Bot 概念文档](../concepts/bot.md)。

第 5 批把设置层并入共享 schema: 5 个内置域改用 `ConfigRoot`, `SettingsDomain` 建在
`ConfigBase` 上(严格 patch / 脱敏 / `apply` / `onCreate` 作为它的策略), 值规则下沉为
`src/config/schema.ts` 的纯函数。`SettingSpec`、`defineSettings`、`toControls` 投影层与
`coercePatch` / `normalizeValues` 一并删除 —— 设置与插件配置现在是同一套控件、同一个引擎,
差别只在写入策略(见文首对照表)。
