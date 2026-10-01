# WebUI 前端 SPA

WebUI 前端是一个不依赖第三方库的极简单页应用, 源码在 `src/webui/public/`:

| 文件 | 职责 |
| --- | --- |
| `app.js` | 入口: 鉴权 → 注册启动时的页面 → `start()` |
| `js/spa/framework.js` | SPA 引擎: 页面注册表、hash 路由、遮罩、一级导航 |
| `js/spa/sidebar.js` | 二级菜单: 菜单表 (声明式 + 运行动态增删) 与侧栏渲染 |
| `js/spa/*.js` | 遮罩、鉴权、toast、API 封装与通用组件 |

## 一级导航 = 页面

```js
import { createApp } from "/js/spa/framework.js";

const app = createApp();          // 默认取 #main / #page-view / #activity-bar / #side-bar
app.register({ id: "home", title: "首页", icon: "/img/icons/home.svg", load: () => import("./js/pages/home/home.js") });
app.start();                      // 之后可以继续注册/注销
```

- 活动栏按钮按注册顺序生成; `#/<页面id>` 是路由, 刷新/前进后退都能定位
- 页面模块可以用 `load()` 动态 import, 也可以直接把 `render()` 写在注册对象里 (内联页面)
- 页面 `render(container, app)` 会拿到应用对象, 可以在里面按数据生成菜单
- 静态注册全部挤在入口里**不是必须的**: 运行期注册会立即反映到活动栏

### 运行期增删页面

```js
app.register({ id: "filter", title: "过滤", render(el) { /* ... */ } }, { index: 0 }); // 新增 (可指定顺序)
app.update("filter", { title: "黑白名单", icon: "/img/icons/shield.svg" });             // 改标题/图标/顺序
app.unregister("filter");                                                              // 删除
app.hasPage("filter"); app.getPage("filter"); app.listPages();                         // 查询
```

- `unregister` 正在显示的页面时: 先 `destroy()` 并移除它的样式, 再落到剩下的第一个页面,
  地址栏同步改写 (`replaceState`, 不新增历史记录)
- hash 指向一个**还没注册**的页面时, 不会硬跳: 先显示第一个页面, 地址栏留着不动 ——
  页面稍后注册上来 (`register`) 会自动按 hash 打开它 (深链补齐)
- `register` 重复注册同一 id 会抛错 (改动用 `update`); `start()` 重复调用只同步一次活动栏

## 二级菜单

页面用 `sidebar` 数组声明 (每次打开该页面时读取一次, 所以页面可以在 `render` 里按后端数据重写它):

```js
export default {
  id: "plugins", title: "插件",
  sidebar: [
    "服务",                                  // 字符串 = 不可点击的文本项 (分组标题)
    { title: "服务", render(el, app) { } },  // 对象 = 可点击项, 内容渲染进页面容器末尾
    { title: "市场", render(el, app) { } },
  ],
};
```

运行期增删 (不传 `{ page }` 就是当前打开的页面):

```js
app.sidebar.add({ title: "规则", render(el) { } });                 // 新增/更新 (可 { index } 指定位置)
app.sidebar.remove("规则");                                          // 删除: id / 下标 / add 返回的对象都行
app.sidebar.set([{ title: "A", render() { } }]);                     // 整表替换 (声明式 sidebar 让位)
app.sidebar.reset();                                                 // 丢掉动态状态, 回到声明式
app.sidebar.list();                                                  // 查: [{ id, title, kind, render }]
app.sidebar.select("规则");                                           // 选中
app.sidebar.refresh();                                               // 重新读 page.sidebar 并刷新
app.sidebar.add({ title: "面板", render(el) { } }, { page: "filter" }); // 给没打开的页面预埋
```

语义 (实现在 `js/spa/sidebar.js`):

- **id**: 项缺省以 `title` 为 id; 同 id 视为同一条菜单 —— 再 `add` 是更新它 (位置不变)
- **记账按页面 id**: 页面没开着时只记录, 该页面打开时一并渲染; 因此注册方不必关心当前在哪一页
- **删除会记住**: 被删的 id 进抑制表, 页面重新声明 `sidebar` 时不会自己冒回来; 再 `add` 同 id 即撤销
- **`set` 接管**: 之后该页的声明式 `sidebar` 不再参与; `reset()` 丢掉全部动态状态 (含抑制表),
  于是又回到页面自己声明的那份菜单
- 二级菜单**不进路由**: 换的只是界面, 地址栏始终只反映一级页面; 页面打开后自动选中首个可点击项
- 没有菜单项的页面侧栏整块隐藏 (`body.nav-collapsed`), 运行期补上菜单项会重新出现

## 页面之外的脚本 (插件前端资源)

插件自带的前端资源与页面模块处在同一个模块图里, import 同一个 URL 就是同一个实例:

```js
import { getApp } from "/js/spa/framework.js";

getApp()?.register({ id: "my-plugin", title: "我的插件", render(el) { /* ... */ } });
getApp()?.sidebar.add({ title: "面板", render(el) { /* ... */ } }, { page: "my-plugin" });
```

应用还没创建 (`createApp` 之前) 时 `getApp()` 返回 `null`, 用 `?.` 跳过即可。

## 自检

```
npm run check:webui-spa   # 无浏览器的冒烟测试: 极简 DOM 桩 + 导航/菜单全套行为断言
```

`scripts/check-webui-spa.mjs` 覆盖: 启动前后注册、`update` 改标题与排序、`unregister` 当前页的
兜底与清理、深链补齐、二级菜单的增删改查/set/reset/预埋/抑制、空菜单的侧栏隐藏与恢复、
窄屏折叠菜单在列表变化时的高度重算, 以及 **TestLab 页面本身的按钮逐个点一遍**。

## 手动验证 (TestLab)

设置页打开 **WebUI → 前端 → 测试实验室** (`frontConfig.enableTestLab`, 热生效), 刷新页面后
活动栏会出现**测试页面**: 里面把上面这些接口全摆成了按钮 —— 点一下就能看到活动栏与侧栏的
即时变化, 等价的 API 调用记在页面的"调用日志"里, 并实时列出本页菜单快照与一级导航现状。

覆盖的演示: 运行期注册/改名/调序/注销页面 (含内联页面自己注销自己)、菜单的追加/插位/文本项/
同 id 更新/set 整表替换/按 id 与按下标删除/select/refresh/reset, 以及给没打开的页面预埋菜单。
