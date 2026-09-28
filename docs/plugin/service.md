# 服务插件 (service)

服务插件是**框架级的基础设施插件**: 它不属于任何 Bot, 在整个进程里只实例化一份, 生命周期由核心管理。

常见的服务插件形态: 跨平台账号绑定、统一鉴权、常驻的存储/缓存、对外 HTTP 服务、后台任务调度等。

## 与普通插件的区别

- **位置**: 放在项目根目录的 `services/<插件id>/`, 与 `plugins/` 平级; 清单里 `type` 必须是 `"service"`。
- **作用域**: 全局单例。普通插件(即使放在全局 `plugins/` 目录)也是每个 Bot 各实例化一份, 这正是服务插件要解决的问题。
- **托管方**: 由核心(Core)持有的 `ServiceHost` 管理 —— 启动时先于所有 Bot 加载, 关闭时后于所有 Bot 卸载。
- **导入**: 不限制模块。`services/` 里的代码属于框架级可信代码, 可以导入 `fs`、`child_process`、`net` 等被普通插件禁止的内置模块。
- **上下文**: 直接持有 `core` 引用。普通插件只能通过 Bot 只读视图访问框架能力。

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

`dependencies` 里可以写其他服务插件的 id: 依赖会先于本插件加载, 存在依赖环或依赖缺失时本插件拒绝加载。

## 上下文能力

`ctx` 提供:

- `logger`: 统一日志
- `message`: 全局消息回调 (`all` / `full` / `start` / `end` / `includes` / `regex` / `match`)
- `command`: 全局指令注册 (`register` / `unregister` / `exec`)
- `event`: 事件过滤与观察 (`filter` / `observe`), 作用于事件传播本身
- `fs`: 数据目录文件读写 (`ctx.path.data` 为根)
- `plugin`: 插件代码目录的只读访问
- `kv`: 简易键值存储, 需先 `ctx.kv.init()`
- `config`: 只读配置视图 (`get` / `has` / `all` / `watch`)
- `exports` / `require`: 与其他服务插件互通
- `core`: 框架核心实例
- `path`: `{ plugin, data }` 两个路径

服务插件不提供 `action`、当前 Bot 视图等 Bot 维度 API —— 它不属于任何 Bot。

## 全局指令与消息回调

`ctx.command` 注册的指令进入**全局指令表**, `ctx.message` 注册的回调进入**全局消息回调**:

- 每个 Bot 收到消息后, 先匹配该 Bot 自己的指令; 未命中再匹配全局指令表;
- 两者都没命中时, 先触发 Bot 插件的消息回调, 再触发服务插件的消息回调;
- 被消息过滤名单拦下的消息不会触发任何服务插件处理。

也就是说, 一个 `/bind` 这样的全局指令对所有 Bot 都生效, 而处理函数拿到的是**当前收到消息的那个 Bot** 的 `Message` 对象 —— 通过它执行回复、撤回等动作。

## 事件过滤与观察

`ctx.message` 是“收到消息后做点什么”，而 `ctx.event` 干预的是**事件传播本身**。适配器派发的事件在进入 Bot 的处理链之前，会先过一遍全部已启用服务插件的过滤器：

```js
export default {
	init(ctx) {
		// 只放行消息事件, 其他事件一律拦住
		ctx.event.filter((event, bot) => event.type === "message.create");

		// 观察通过过滤的事件(包括 EntityFactory 不认识的裸事件)
		ctx.event.observe((event, bot) => {
			ctx.logger.log(`[${bot.id}] ${event.type}`);
		});
	}
};
```

- `filter(predicate)`：遍历全部过滤器，**任一返回 false 就丢掉该事件**（AND 语义）；第二个参数是收到事件的 Bot, 便于做“只在某些 Bot 上放行”的判断。
- `observe(handler)`：不参与拦截，只观察；在过滤器全部通过后触发，能拿到 `EntityFactory` 不认识、不会被任何处理链消费的事件。
- **过滤器抛错时按放行处理**并记录日志：拦截是显式意图，不能让一个出错的过滤器使事件无声消失。
- 过滤器与观察回调都注册在服务插件上，卸载时自动清空，只对**已启用**的服务插件生效。

## 导出与依赖

服务插件之间、以及 Bot 插件对服务插件, 都通过 `ctx.exports` / `ctx.require` 互通:

```js
// 服务插件 a
export default {
	init(ctx) {
		ctx.exports = { hello: () => "hi" };
	}
};
```

```js
// 另一个服务插件, 或任意 Bot 的普通插件
const a = ctx.require("a");
```

- 服务插件的导出对所有 Bot 的插件可见;
- 同名时 Bot 私有插件的导出优先于服务插件;
- 目标插件卸载后导出立即释放, 因此不要缓存 `ctx.require` 的返回值。

## 示例

```js
// services/bind/index.ts
export default {
	init(ctx) {
		ctx.command.register("bind", async (msg, args) => {
			if (!msg) return; // 指令表是全局的, 但处理总是绑定到某个 Bot 的消息

			const token = args[0];
			if (!token) {
				const created = ctx.core.bindManager?.new(msg.sender.id);
				if (!created) return;
				await msg.reply(`绑定令牌: ${created} (5 分钟内有效)`);
				return;
			}

			const result = ctx.core.bindManager?.bind(msg.sender.id, String(token));
			await msg.reply(result?.success ? "绑定成功!" : `绑定失败: ${result?.message ?? "未知原因"}`);
		});
	},
	unload(ctx) {
		// ctx.command 注册的指令会由框架自动注销, 其他资源请在
		// unload/error 里自行释放(定时器、连接、监听器等)
	}
};
```
