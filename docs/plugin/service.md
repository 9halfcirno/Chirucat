# 服务插件 (service)

服务插件是**框架级的基础设施插件**: 它不属于任何 Bot, 在整个进程里只实例化一份, 生命周期由核心管理。

常见的服务插件形态: 跨平台账号绑定、统一鉴权、常驻的存储/缓存、对外 HTTP 服务、后台任务调度等。

本文只介绍服务插件本身(放在哪、由谁管理、清单与配置怎么写); 上下文的完整 API 见[服务插件上下文](contexts/service.md)。

## 与普通插件的区别

- **位置**: 放在项目根目录的 `services/<插件id>/`, 与 `plugins/` 平级; 清单里 `type` 必须是 `"service"`。
- **作用域**: 全局单例。普通插件(即使放在全局 `plugins/` 目录)也是每个 Bot 各实例化一份, 这正是服务插件要解决的问题。
- **托管方**: 由核心(Core)持有的 `ServiceHost` 管理 —— 启动时先于所有 Bot 加载, 关闭时后于所有 Bot 卸载。
- **导入**: 不限制模块。`services/` 里的代码属于框架级可信代码, 可以导入 `fs`、`child_process`、`net` 等被普通插件禁止的内置模块。
- **上下文**: 提供与普通插件同名的能力, 但**作用域是全局的** —— 注册的指令、消息回调与事件过滤器对所有 Bot 生效; 核心也由收窄过的 `ctx.core` 视图提供, 而不是 `Core` 实例本身。详见[服务插件上下文](contexts/service.md)。
- **模块契约**: 入口默认导出的 `{ init(ctx), unload?(ctx), error?(err) }` 与普通插件完全一致。

放错地方的插件会被跳过并告警: `services/` 里只收 `type: "service"`; 反过来, Bot 插件目录里出现 `type: "service"` 的插件也会被跳过。

## 目录与文件

以 `services/bind/` 为例:

- `manifest.json`: 插件清单, 必需
- 入口文件(清单里的 `main`, 例如 `index.ts`), 默认导出 `{ init(ctx), unload?(ctx), error?(err) }`
- `config.json` (可选): 配置控件定义与默认值, 由清单的 `config` 字段指向

运行期产生的内容:

- 配置值: `configs/services/<插件id>.json` (全局, 不按 Bot 隔离)
- 状态文件: `configs/services/state.json` (启停期望态, 见下节)
- 数据目录: `data/services/<插件id>/` (`ctx.fs` 与 `ctx.kv` 的根)

## 持久化启停状态

服务插件的启停偏好持久化在 `configs/services/state.json`:

```json
{
	"disabledServices": ["some-service"]
}
```

语义是**默认启用、只记录停用**(opt-out), 与 Bot 的 `state.json`(白名单) 正好相反:

- 文件不存在、或名单为空 → 所有服务插件都期望启用 —— 这与引入这个文件之前的行为一致, 新装的服务插件直接可用;
- 只有被显式停用过的服务才出现在名单里, 因此在 WebUI 里关掉一个服务, 重启后它仍然是关的。

连带规则与 `load` / `unload` 自身的递归语义一致, 保证运行态与名单不会各说各话:

- 停用一个服务: 依赖它才能运行的服务会被一并卸载, 并一起记进停用名单;
- 启用一个服务: 它依赖的服务会被一并加载, 并一起移出名单;
- 若手工把文件改成"依赖被停用、依赖者却期望启用", 启动时会跳过依赖者并告警 —— 递归加载会把停用项重新拉起, 与文件矛盾 —— 但不会改写文件。

其它约定:

- 写入一律经过状态管理器: 原子写 + 串行化, 并且**先收敛运行态成功, 再落盘**; 收敛失败不写文件, 文件里不会留下做不到的期望;
- 期望态可被外部修改: 核心启动后会监听该文件, 外部改动会自动触发运行态收敛(与 Bot 的 `state.json` 一样);
- 运行态永不回写文件, 文件只表达"期望变成什么样"。

## 在 WebUI 中管理

WebUI 的**插件**页面下有"服务"子页面, 可以:

- 查看全部服务插件(名称 / 版本 / 作者 / 描述 / 运行状态);
- 用开关启停单个服务, 受依赖连带影响的服务会在提示里列出;
- 编辑声明了 `config` 的服务插件配置(值写入 `configs/services/<插件id>.json`);
- 重新扫描 `services/` 目录并**按期望态收敛运行态**(会加载/卸载服务): 新丢进目录的插件直接启用, 停用名单里的保持关闭, 让列表与磁盘一致。

WebUI 的读取与改动都走 `ServiceHost`, 不会绕过期望态直接启停某个服务。

## 自带的 WebUI 端点、静态资源与页面

服务插件可以自己提供 WebUI 用的接口、前端资源与导航页面, 各有固定的命名空间, **不需要(也无法)**注册核心的路由表:

| 内容 | 位置 | 谁来挂 |
| --- | --- | --- |
| HTTP 端点 | `/service/<插件id>/api/<路径>` | 插件在 `init` 里 `ctx.core.webui?.register({ path, method, auth?, handler })` |
| 静态资源 | `/service/<插件id>/public` | 框架: 插件代码目录下的 `public/` 自动挂载 |
| 一级导航页面 | 活动栏 | 插件在 `init` 里 `ctx.core.webui?.pages.register({ id, title, module, ... })` |
| Bot 窗口页面 | Bot 详情窗口的二级导航 | 插件在 `init` 里 `ctx.core.webui?.bot.pages.register({ id, title, module, ... })` |

```js
export default {
	init(ctx) {
		ctx.core.webui?.register({
			path: "filter_list",
			method: "POST",
			auth: true,            // 缺省 true
			handler: body => ({ entries: [] })
		});

		// 管理界面: 页面模块与样式都在本插件 public/ 下
		ctx.core.webui?.pages.register({
			id: "global", title: "黑白名单", icon: "shield.svg",
			module: "global.js", styles: ["filters.css"], order: 50,
		});
		ctx.core.webui?.bot.pages.register({
			id: "filter", title: "名单", icon: "shield.svg",
			module: "bot.js", styles: ["filters.css"], order: 30,
		});
	}
};
```

约定:

- 端点、静态资源与页面都落在**本插件自己的命名空间**里, 与核心的 `/api/*`、其它插件的端点完全隔离;
- 端点默认**要求鉴权**(与核心 API 同一套密码 / 本机免密 / Cookie), 静态资源不鉴权;
- 服务被停用后, 端点返回 503("服务插件 xxx 未启用"), 静态资源回到 404, **注册的页面从导航里消失**(已经打开的 Bot 详情窗口也会当场去掉那一项);
- WebUI 未启用时 `ctx.core.webui` 为 `null`, 跳过注册即可, 服务的本职工作(如消息过滤)不受影响;
- 上下文释放时框架会自动注销这些注册, 插件不必自己记。

完整 API、页面模块的写法与缓存注意事项见[服务插件上下文](contexts/service.md#corewebui对象)与[自带静态资源](contexts/service.md#自带静态资源)、[WebUI 前端 SPA](../webui/spa.md)。

## 清单

与普通插件一致, 差别只在 `type`:

```json
{
	"id": "bind",
	"version": "0.0.0",
	"name": "跨平台绑定",
	"author": "Someone",
	"type": "service",
	"main": "index.ts",
	"config": "config.json",
	"dependencies": {}
}
```

`dependencies` 里可以写其他服务插件的 id: 依赖会先于本插件加载, 存在依赖环或依赖缺失时本插件拒绝加载。依赖方可以通过 `ctx.require` 取到对方发布的导出(见[服务插件上下文](contexts/service.md#插件间导入导出exportsrequire))。

## 上下游

- 上下文 API: [服务插件上下文](contexts/service.md)
- 插件清单与模块格式: [插件格式](format.md)
- 开发准则: [插件开发准则](guidelines.md)
