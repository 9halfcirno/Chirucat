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
revision 守卫 + 外部改动监听), 与 `ConfigManager` 共用同一套落盘机制。

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
	onLoad: (values) => { /* 载入/外部改动后同步给运行中的对象 */ },
	watchFile: false,   // 需要响应手工编辑值文件时才开
});
await domain.load();
```

- `apply` 只收到**本次真正变化**的字段, 且已剔除 `restart` 字段 —— 需要重启才生效的项
  在运行期没有意义, 机制上不让它进热应用。
- `apply` 抛错不回滚已落盘的值, 而是抛 `SettingsApplyError`(其 `outcome` 已脱敏),
  消息是"已保存, 但热应用失败"。
- 值文件缺失时按定义生成默认值; 内容损坏时: `JsonFileStore` 默认 `throw`
  (不静默覆盖用户数据)。

## 内置的域

- **`core`** (`configs/core.json`): `webui`(只读 —— 关掉就再也进不来)、`statistics` 模块开关(热生效: 开着就建、关了就关)
- **`webui`** (`configs/webui.json`): 密码 / 监听端口 / 监听地址 / 本机免密 / `frontConfig` —— 全部热生效
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
- **接口**: `POST /api/get_bot_config { id }` 与 `POST /api/update_bot_config { id, patch }`,
  返回形状与全局设置域一致, 前端复用同一套渲染。

> 值文件按定义白名单规范化, 定义外的键会在下一次写入时被丢弃 ——
> `config.json` 里出现的字段必须都写进定义。

## 语义标记

- **`secret`**: 只允许用在 `string` 上。对外读取(`read()`)一律脱敏为空串,
  patch 里**空串表示不修改**、**null 表示清除**(回落默认值)。
  `get()` 与 `watch()` 是明文内部通道, 不得把它们的值写进日志或任何外流结构。
- **`restart`**: 改动会落盘, 但不进 `apply`, 且出现在接口返回的 `restartRequired` 里, 前端据此提示"需重启 Core 后生效"。
  **当前内置的域没有用到它** —— 能热的都做成热的了 (`WebUIServer.relisten` 换监听、`updateSecurity` 换密码与免密、`StatisticsManager.updateOptions` 改统计参数); 机制保留给将来真正无法热更的项(如数据库路径)。
- **`widget`** (仅 `number`): 缺省规则是"给了 `min` & `max` 就用滑块"; 跨度太大或需要精确输入时显式写 `widget: "input"` —— 端口就是这种情况。
- **`immutable`**: 设置接口(patch)不接受把它改成别的值; 提交等值不算改动。
  它**只约束 patch** —— 手工编辑值文件仍会让新值生效(与 `state.json` 的处理一致)。

## 接口

- `GET /api/get_settings` → `{ domains: [{ id, define, values, setSecrets, restartFields, immutableFields }] }`

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
```

接口层自检走真实 Core 与真实 handler, 但把域指向临时文件, 并比对
`configs/webui.json` 的哈希以自证没碰仓库里的配置。
