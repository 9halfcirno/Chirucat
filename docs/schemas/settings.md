# 设置 (Settings)

面向**框架自身**的可变配置: WebUI 端口与密码、Core 模块开关、统计参数 ...
插件配置仍走 [Config Schema](./config.md) —— 那套由插件自带的 schema 驱动, 两者并存。

## 为什么要另起一层

`ConfigManager` 把三件事绑在同一份控件树上: 前端渲染、默认值来源、校验与白名单
(`coerce` 以控件为白名单丢弃未知键)。于是"不是表单形状"的设置项无处安放:
要么为存储伪造一份控件, 要么退化成裸 JSON 读写、丢掉默认值与校验。

设置层把**定义**和**表述**分开:

- **定义** (`SettingSpec`, 见 `src/config/settings/types.ts`) —— 数据层的真相源:
  类型、默认值、校验、语义标记(`secret` / `restart` / `immutable`)
- **投影** (`toControls`, `src/config/settings/compile.ts`) —— 把定义转成 `Control[]`,
  单向且可丢弃; 前端 `config-editor` 只认控件树, 于是它零改动就能渲染设置
- **域** (`SettingsDomain`, `src/config/settings/manager.ts`) —— 一份定义 + 一个值文件 + 一个热应用钩子

存储底座是 `src/config/store.ts` 的 `JsonFileStore`(原子写 + 串行化的 `SerialQueue` +
revision 守卫 + 外部改动监听), 设置域、期望态存储与 `ConfigManager` 共用同一套落盘机制。
三者的差异由传给 store 的选项显式表达: 设置域值文件损坏时备份重建、状态文件回落默认、
插件配置值文件语法错误照常抛出 —— 不要把这几种容错语义混成一种。

`JsonFileStore` 的**外部改动监听能力不是每个调用方都要开**: Bot / 服务期望态文件靠它
收敛启停, 而设置域与 `ConfigManager` 刻意不开 —— 框架设置几乎都经 WebUI/API 写入,
插件配置更是; 每份配置挂一个目录 `fs.watch`, 在几十上百个插件同时启用时句柄数与事件
唤醒会成倍放大。手工编辑设置或插件配置的值文件需重启(或显式 `load()`)才生效。

## 加一个设置项

只改定义; 存储、接口、前端都不用动:

```ts
export const webuiSettings = defineSettings({
	groups: { frontConfig: { label: "前端" } },
	fields: {
		port: {
			type: "number", default: 7636, min: 1, max: 65535,
			integer: true, restart: true, label: "监听端口",
		},
		"frontConfig.enableTestLab": { type: "boolean", default: false, label: "测试实验室" },
	},
});
```

- 键支持点号路径, 中间前缀会投影成 `group`; 分组标题在 `groups` 里声明。
- `defineSettings` 会在**启动时**校验定义本身(键是合法路径、类型受支持、默认值自洽、
  enum 有 items、字段键之间不互为前缀 ...), 定义写错立刻炸, 不会拖到用户点保存。
- 类型 → 控件: `string`→input(`multiline` 时 textarea, `secret` 时密码框)、
  `number`→有 `min`&`max` 时 slider、否则数字输入框、`boolean`→switch、
  `enum`→select、`stringList`→有 `items` 时 checkbox, 否则多行文本(按行拆分)。

## 加一个设置域

```ts
const domain = core.settings.register<WebUISettings>("webui", {
	definition: webuiSettings,
	file: WEBUI_SETTINGS_FILE,
	apply: (values, changed) => { /* 只需重启的字段不会进来 */ },
});
await domain.load();
```

- `apply` 在**落盘成功后**调用, 只收到本次真正变化的字段, 且已剔除 `restart` 字段 ——
  需要重启才生效的项
  在运行期没有意义, 机制上不让它进热应用。
- `apply` 抛错不回滚已落盘的值, 而是抛 `SettingsApplyError`(其 `outcome` 已脱敏),
  消息是"已保存, 但热应用失败"。
- 值文件缺失时按 `onCreate`(缺省取定义默认值)生成; 内容损坏时先把原文件改名为
  `<文件>.broken-<时间戳>-<随机>` 备份, 再按同样的默认值重建一份 —— 既不静默跳过、
  也不阻断启动。`load()` 返回 `{ values, created, recovered, backupFile? }` 供启动层
  打印初始密码或告警; 域定义文件本身不掺日志逻辑。
  只要值的旧调用方仍在: `get()` 取当前值, 底层 `JsonFileStore.load()` 也仍返回值本身
  (需要元信息改用 `loadOutcome()`)。

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
- **接口**: `POST /api/get_bot_config { id }` 与 `POST /api/update_bot_config { id, patch }`,
  返回形状与全局设置域一致, 前端复用同一套渲染。

> 值文件按定义白名单规范化, 定义外的键会在下一次写入时被丢弃 ——
> `config.json` 里出现的字段必须都写进定义。

## 语义标记

- **`secret`**: 只允许用在 `string` 上。对外读取(`read()`)一律脱敏为空串,
  patch 里**空串表示不修改**、**null 表示清除**(回落默认值)。
  `get()` 是明文内部通道, 不得把它的值写进日志或任何外流结构。
- **`restart`**: 改动会落盘, 但不进 `apply`, 且出现在接口返回的 `restartRequired` 里, 前端据此提示"需重启 Core 后生效"。
  **当前内置的域没有用到它** —— 能热的都做成热的了 (`WebUIServer.relisten` 换监听、`updateSecurity` 换密码与免密、`StatisticsManager.updateOptions` 改统计参数); 机制保留给将来真正无法热更的项(如数据库路径)。
- **`widget`** (仅 `number`): 缺省规则是"给了 `min` & `max` 就用滑块"; 跨度太大或需要精确输入时显式写 `widget: "input"` —— 端口就是这种情况。
- **`immutable`**: 设置接口(patch)不接受把它改成别的值; 提交等值不算改动。
  它**只约束 patch** —— 手工编辑值文件仍会让新值生效(与 `state.json` 的处理一致)。

## 接口

- `GET /api/get_settings` → `{ domains: [{ id, define, values }] }`

  `define` 是 **`ConfigRoot`** (`{ controls: [...] }`), 与 `get_plugin_config` 一致 —— 前端
  `createConfigList` 读的就是 `define.controls`, 传裸数组会渲染成空表单 (表现为"一个设置项
  都没有")。`values` 已脱敏。
- `POST /api/update_settings` `{ domain, patch }` → `{ values, changed, restartRequired }`
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
npm run check:settings   # 定义/投影/校验/落盘/并发/竞态 + 接口层端到端
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
两个子类只剩差异策略与各自的编排层: 服务宿保留期望态/串行队列/依赖连带/释放流程,
插件宿保留双目录扫描与适配器动作派发。`npm run check:managed-host` 用探针宿主直接验
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
