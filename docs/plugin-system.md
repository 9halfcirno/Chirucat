# 插件系统设计：树状依赖加载

> 目标：以树状结构组织插件依赖。`scan()` 只负责扫描清单并构建依赖树，**不加载**；
> 加载由独立的 `load()` 按 root → 叶顺序执行，任何节点失败即取消后续并回滚；
> `unload()` 从叶节点逆序**强制卸载**目标插件的整棵子树。

## 1. 与旧方案的区别

旧设计（`src/plugin/manager.ts` 中的 `pending` 挂起表）采用"宽松式"加载：
依赖不满足的插件先挂起，等依赖就绪后再恢复。优点是允许部分加载，
代价是状态机复杂、加载顺序不确定、失败语义不透明。

新方案改为**批次事务式**加载，且职责分离：

- `scan()` 只扫描清单、构建依赖树、做静态校验，**不加载任何模块**
- 加载由 `load()` 按拓扑序执行，任何节点失败 → 中止并回滚整个批次
- 语义可预测：`scan()` 只负责注册与校验；`load()` 要么整体成功，要么整体失败并给出首个失败原因

## 2. 数据结构

依赖关系本质是 DAG（一个插件可依赖多个插件，多个插件可共享同一依赖），
这里用"共享节点的树"表示：**每个插件只有一个节点**，节点通过
`dependents` 被多个父节点引用。

树的方向定义（关键，避免歧义）：

- **边**：`X 依赖 Y` ⇒ `Y.dependents` 含 `X`
- **树根**：不依赖任何其他插件的插件（虚拟 root 之下）
- **子节点**：直接依赖父节点的插件
- **加载顺序**：root → 叶（被依赖者先加载，依赖者后加载）
- **卸载顺序**：叶 → root（依赖者先卸载，被依赖者后卸载）

```ts
type PluginId = string;

type PluginNode = {
  manifest: PluginManifest;          // 清单（含 dependencies 版本约束）
  deps: Map<PluginId, PluginNode>;   // 本插件依赖谁（祖先/父）
  dependents: Set<PluginNode>;       // 谁依赖本插件（子）
  plugin: Plugin | null;             // 加载后的实例
  state: PluginState;
};

type PluginState =
  | "registered"   // 已注册清单，未加载
  | "loading"
  | "loaded"
  | "unloading"
  | "unloaded"
  | "error";
```

## 3. 加载流程

### 3.1 `scan(dir)` —— 只扫描，不加载

```
1. 读取清单
   遍历插件目录，每个子目录读 manifest.json
   校验必填字段：id、version、main
   构建 Map<id, Manifest>；id 重复 → 报错中止

2. 构建依赖树
   对每个清单解析 dependencies，建立 deps / dependents 引用
   静态校验（任一失败 → 整体拒绝，什么都不加载）：
     a. 依赖存在性：dependencies 中的 id 必须在清单集合内
     b. 版本约束：用 VerChecker 校验（= > < >= <= !=）
     c. 环检测：DFS 三色标记，A→…→A 直接报错并标出环路径

3. 拓扑排序
   根集合 = 无 deps 的节点
   以 root → 叶的顺序生成加载序列（等价于拓扑序，Kahn 或 DFS 后序）

4. 所有插件标记为 registered，等待 load()
```

`scan()` 不触发任何模块加载，只完成注册与校验。

**重复扫描**：`scan()` 可重复调用，已扫描目录会被合并记忆；再次扫描会
刷新节点表与树，新出现的插件注册为 `registered`（等待 `load()`），
已加载插件保持 `loaded` 不重新加载。若已加载插件在扫描结果中消失
（目录被删除或 id 变更），抛错保护，提示先 `unload()`。

### 3.2 `load()` —— 执行加载

```
- 无参 load()：加载全部 registered 插件，按拓扑序 root → 叶
- load(id)：加载指定插件及其整条依赖链（deps 祖先，同样按拓扑序）

对每个节点：
  a. loader.load(main) → esbuild bundle → 取 PluginModule
  b. 构造 Plugin 实例
  c. 构造 PluginContext（含已加载的 deps 实例）
  d. 调用 module.init(ctx)

任一节点失败（bundle 失败 / init 抛错）：
  → 中止后续所有加载
  → 已加载节点按逆拓扑序（叶 → root）逐个 unload 回滚
  → 本次 load() 抛错，plugins Map 不包含任何本次新增项

全部成功 → 注册进 plugins Map，返回加载结果
```

失败的两类时刻：

- **静态失败**（清单缺失字段 / 依赖缺失 / 版本不匹配 / 环）
  —— 在 `scan()` 构建树阶段整体拒绝，未加载任何东西
- **运行时失败**（bundle / init 抛错）
  —— 在 `load()` 阶段中止，回滚已加载节点

## 4. 卸载流程 `unload(targetId)` —— 强制卸载整棵子树

```
1. 收集目标子树：递归收集 target 的直接/间接 dependents 中所有已加载节点
2. 按逆拓扑序（叶 → target）逐个卸载：
     a. 调用 plugin.module.unload()
     b. 从 plugins Map 移除
     c. 标记 unloaded
3. 最后卸载 target 自身
```

要点：

- **强制性**：子树内所有节点一律卸载，不做共享依赖保护
- 风险提示：若子树节点同时被树外其他已加载插件依赖，卸载后那些插件
  通过 `ctx.deps` 访问将拿到已卸载实例 —— 调用方需自行保证不引用
  已卸载的子树
- 目标不存在或未加载 → 直接返回，不报错（幂等）

## 5. 插件上下文与插件间交互

```ts
type PluginContext = {
  id: string;
  manifest: PluginManifest;
  deps: Record<string, Plugin>;  // 已加载的依赖实例
  // 后续可扩展：logger、config、eventBus…
};
```

插件通过 `ctx.deps` 访问依赖插件的能力，禁止插件之间直接 `import`
（esbuild bundle 时各插件是独立 iife，模块隔离是刻意设计）。
依赖插件的能力如何对外暴露（模块导出 API / 框架级 API 注册表）是
后续决策点，不影响本设计。

## 6. 并发与状态

- `PluginManager` 内部加互斥：同一时刻只允许一个 `scan()` / `load()` /
  `unload()` 批次运行，避免交错
- 依据状态机拒绝重复加载 / 重复卸载
- 插件状态暴露给外部查询（`getPluginState(id)`）

## 7. 现有代码改造清单

- `src/plugin/types.ts`：`PluginContext` 增加 `deps`；新增 `PluginState`；
  可新增 `PluginNode` 类型
- 新增 `src/plugin/dependency-tree.ts`：`buildTree(manifests)`
  → `{ roots, nodes, topoOrder }`，内含存在性 / 版本 / 环校验与拓扑排序
- `src/plugin/manager.ts`：重写 `scan()` 为只扫描清单 + 建树 + 静态校验；
  新增 `load()`（拓扑序加载，失败回滚）与 `unload()`（强制卸载子树）；
  移除 `pending` 挂起表
- `src/plugin/loader.ts`：保留 esbuild 逻辑；错误信息携带插件 id；
  明确 `_availableImport` 策略（建议禁止插件间 import，统一走 deps 注入）
- `src/plugin/plugin.ts`：增加 `unload()` 与状态字段
- 示例插件 `plugins/des`、`plugins/ping`（ping 依赖 des）可直接验证：
  des 先加载、ping 后加载；卸载 ping 不影响 des；卸载 des 会先卸 ping

## 8. 边界与决策点

1. **依赖缺失的语义**：本设计按你的要求——整体取消后续所有加载。
   注意这与旧"挂起等待"策略是行为变更（更严格、更可预测）
2. **环检测**：拓扑排序本身会失败，但显式三色标记能给出环路径，便于排错
3. **enable / 禁用插件**（PLAN.md 提到按 enable 启动）：可在建树前过滤；
   但若禁用插件被其他已启用插件依赖，需决策——本设计建议依赖优先，
   被依赖插件即使未 enable 也加载（否则依赖它的插件无法工作）
4. **目录约定**：一个子目录一个插件，目录名仅作兜底，id 以 manifest 为准
5. **强制卸载的连带风险**：卸载目标子树时不保护共享依赖，被其他插件
   引用的节点也会被强制卸载；若日后需要保护，可再提供"仅卸载无引用
   节点"的宽松模式，默认按强制语义执行
