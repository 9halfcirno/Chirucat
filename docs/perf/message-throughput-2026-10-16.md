# Chirucat 消息链路压测报告 (2026-10-16)

版本: 0.3.0 · 平台: Windows 10 (10.0.19045) · Node v24.13.0 · 4 逻辑核 / 8 GB

## 1. 结论速览

| 问题 | 结论 |
| --- | --- |
| 单进程消息吞吐天花板 | **≈ 5154 msg/s**(典型装配连续灌满,主线程 97.9% 忙),折合 **194 µs/消息** |
| 稳定跟得上的速率 | 无干扰时 **≈ 1450–1500 msg/s** 开始跟不上(丢弃 >3%);**≤400 msg/s 全部稳**(各场景丢弃 ≤2.8%),800 msg/s 是最重的两个装配(quiet/identity)开始丢 ~5% |
| 尾延迟 | 天花板负载下同步处理 mean 0.190 ms / p95 0.327 ms / p99 0.517 ms / max 22.3 ms |
| 每消息 CPU | 闭环满载(burst,无 profiler):典型装配 **194 µs/条**;窗口 profile 口径(横向比较用):core 376 → 加统计 436 / typical 411 / 关掉每消息日志 246(**日志 ≈165 µs,≈40%**) |
| 最大瓶颈 | ① 每消息重新 `prepare()` SQL ② 每消息同步日志(字符串+两次查询先做、级别后判) ③ 新用户/会话落账(2.8~3.6 ms/条且阻塞事件循环) |
| 慢 handler 有无失控 | 无。15% 消息进 `await 10ms` 的 handler,在途峰值仅 12,吞吐不受影响(1600 msg/s 档仍能送 1518) |
| 统计模块值不值得优化 | 不值得。开销最小(+60 µs/消息,0.3 ms 同步 mean),空转 CPU 0% |
| 会不会把机器搞死 | 压测台带熔断(丢弃率/尾延迟/事件循环/RSS/整机 CPU/在途),全程最高 RSS 370 MB,未触及 |

一句话:框架的同步消息链本身很轻(闭环灌满时典型装配 194 µs/条),**真正吃掉 CPU 的是日志落屏与身份落账的 SQLite 语句重编译**,两者都是局部改动、不动架构就能拿回一半开销。

## 2. 测试口径

**测的是哪一段:** 压测台把事件直接喂给 `Bot.dispatch`,即"适配器已经收到平台数据、反序列化完成"之后的那一步。因此**不含**网络收包、平台反序列化、适配器自身逻辑,也不含 WebUI/日志持久化。

**数据落在哪:** 每个场景一套独立沙盒(`data/bench/<场景>-<随机>/`:internal.db / statistics.db / bots/bench-bot),跑完统一删除;真实 `bots/`、`configs/`、真实库不碰。不调 `Core.init()`(它会扫 `bots/` 并按 state 拉起真实 Bot),而是按 init 的同一顺序手工装配同一批设施。

**流量:** 开环发生器,10 ms 一帧按应发数派发,允许追赶 3 帧(`catchUpCap = ceil(rate×10×3/1000)`),超出即记 `shed`(丢弃)。这是"上游按真实速率灌、框架跟不上"的口径,不是自限速。

**夹具:** `bench-adapter`(回 ack,并记录 e2e)、`bench-echo`、`bench-reply`(20% 消息触发回复)、`bench-command`(20% 命中指令)、`bench-async`(15% 进 `await 10ms`)。服务插件用真实的 `chirucat-permission`。

**场景:**

| id | 装配 | 流量 |
| --- | --- | --- |
| core | 只有适配器,无统计无服务插件 | 纯聊天 |
| stats | core + 统计模块 | 纯聊天 |
| typical | 统计 + permission + 4 个业务插件 | 20% 指令 / 20% 回复 |
| quiet | 同 typical,日志级别调到 warn | 同上 |
| identity | 同 typical,但 200 用户 / 20 会话在开跑前就落库(热库),流量直接取热池里的账号 uuid 当平台 id | 同上 |
| fresh | 同 typical,每条消息一个新用户 + 一个新会话 | 同上 |
| async | 同 typical + 慢 handler 插件 | 15% 走 await |
| burst | 同 typical,不设速率连续灌 | 同上 |

**熔断阈值:** 丢弃 >3%、同步 p99 >30 ms(样本 ≥100)或单次 >200 ms、事件循环 p99 >100 ms、RSS >1200 MB、整机 CPU >88%、在途 handler >5000。任一破线本档停止加压。

**空转基线与噪声判定:** 每个场景先量 6 s 零消息静置基线,之后的 CPU 一律折算成"相对静置多花多少"。某档掉速时,若本进程相对静置没多花 35% 单核 CPU、且消息链占用(忙比) <25%,判为**环境干扰**而不是框架饱和:先静置 3 s 重测该档,重测仍受扰则作废该档并继续加压,只有**连续两档**受扰才收手。

## 3. 环境与已知干扰(读数字前必看)

这台机器当前有持续的外部抢占:快照里 `Qoder CN` 两个进程就吃掉 ~1.4 个核,本进程静置时**整机噪声 51.9%**(开局实测 36%~62% 之间浮动)。影响:

- 阶梯里"整机 CPU >88%"这条保命线会被外部负载触发,受扰档位已在表格里标 `noise` 并按上述规则处置。
- **跨场景 ±20% 以内的差异不可信**(例如 core 与 stats 在同一档的忙比会互相反超)。因此分层归因不用阶梯墙钟数字,而用 §5 的 CPU profile(按忙时占比,与墙钟抢占无关)。
- 任务管理器里"看不到波动"是正常的:100 msg/s 只要 2% 单核,800 msg/s 也才 30% 单核。

另外两个测量自身开销,已排除在结论外:`post @ node:inspector`(profiler 自身,忙时 3~8.5%:core 3.9% / typical 4.8% / burst 7.0% / quiet 8.5%)、`maybeCacheGeneratedSourceMap`(tsx 源映射,identity 场景忙时 4%)。

## 4. 吞吐与延迟

### 4.1 阶梯(无 profiler,`data/bench/results-final.json`)

每格:同步 mean / p99 / 忙比(主线程在消息链里所占的时间片)。`定性` 列 `ok`=健康,`noise`=环境抢占,`load`=框架自身饱和。

**core(纯核心链,静置 CPU 1.3%)**

| 目标/s | 实际/s | mean ms | p99 ms | 忙比 | 超静置CPU | 定性 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10 | 9.8 | 0.662 | 1.97 | 0.6% | ~0% | ok |
| 100 | 99.6 | 0.488 | 2.32 | 4.9% | 0.6% | ok |
| 200 | 199.3 | 0.338 | 1.20 | 6.7% | 1.2% | ok |
| 400 | 340.6 | 0.485 | 3.95 | 16.5% | 10.9% | noise(重测) |
| 800 | 724.9 | 0.426 | 2.90 | 30.9% | 29.5% | load,丢弃 7.9% → 停 |

**stats / typical / async 三档都跑到 1600 msg/s 才熔断**,实测送达分别在 1452 / 1406 / 1518 msg/s:

| 场景 | 800 msg/s mean/p99/忙比 | 1600 msg/s 送达 | 熔断原因 |
| --- | --- | ---: | --- |
| stats | 0.326 / 2.07 ms / 25.6% | 1452/s | 丢弃 9.0% |
| typical | 0.428 / 2.32 ms / 33.4% | 1406/s | 丢弃 11.6% |
| async | 0.233 / 0.77 ms / 18.5% | 1518/s | 丢弃 4.5% |

**quiet / identity 在 800 msg/s 熔断**,且都紧跟在一个被判 `noise` 的 400 msg/s 档之后——抢占是连档的,数字偏悲观:quiet 800/s 忙比 26.5%,identity 800/s 忙比 34.9%(它的 400/s 档是干净的:0.749 ms / 28.6%)。

**fresh 是唯一真实的软肋:** 每条一个新用户+新会话时,25 msg/s 就开始出现 shed,100 msg/s 只送达 77/s(丢 22%),事件循环 p99 冲到 **243 ms**。注意它的进程 CPU 只有 17%——**不是 CPU 不够,是同步 SQLite 写入把事件循环堵住了**(见 §5.3)。

### 4.2 天花板(burst,不设速率)

| 指标 | 值 |
| --- | --- |
| 吞吐 | **5153.8 msg/s**(2.0 s 窗口内 10308 条,全部送达,0 丢弃) |
| 同步处理 | mean 0.190 ms,p50 0.163,p95 0.327,**p99 0.517**,max 22.29 ms |
| 主线程占用 | 97.9%(即单核已经打满) |
| 每消息 CPU | 194 µs |
| RSS 峰值 | 370 MB(窗口内 10308 条消息体 + 日志缓冲;阶梯里同装配 1600/s 时是 185 MB) |
| GC | 0 次(短窗口);阶梯长窗口里 GC 占 2~5% 忙时 |

**为什么阶梯在 1400~1500 msg/s 就丢包,而 burst 能灌到 5154?** 因为 burst 是闭环(处理完一条再取下一条),阶梯是开环:上游不停,主线程一旦偶发卡住(GC 停顿、外部抢占、SQLite 同步写),10 ms 帧里欠下的量超过追赶上限(3 帧)就丢。所以:

- **194 µs/消息 → 单核理论上限 ≈5150 msg/s** 是框架能力的口径(实测天花板正落在这上面);
- **≈1500 msg/s** 是"开环、有偶发停顿"时能稳住不丢包的口径,更接近真实群聊突发;
- 想把稳态吞吐往 3000+ 推,关键不是让链路更快,而是**消灭偶发的同步阻塞**(§6)。

## 5. 分层开销归因(CPU profile,只覆盖采样窗口)

`data/bench/prof3/*.cpuprofile`,同一档(800 msg/s,`--step=8`)分别记录;占比按**忙时**(排除 idle/program)算。原生帧(SQLite 语句、控制台写)的时间记给调用它的源码函数,故能直接读"这一层花了多少"。

### 5.1 typical(典型装配)窗口忙时 Top

| 忙占比 | 归属 | 说明 |
| ---: | --- | --- |
| 19.6% | `_logMessage` (src/bot/message-handler.ts:44) | 其中 324 ms 是它触发的两次 SQLite 查询 |
| 16.4% | `getUnion` (src/internal/user-manager.ts:277) | 每条消息取 union id:函数里最多 4 次 `db.prepare()`,含 246 ms 原生 |
| 12.8% | `write` (src/utils/logger.ts) | 控制台写,235 ms 原生 |
| 5.9% | `recordSend` (src/bot/bot.ts) | 发送动作落账 |
| 5.4% | `writeSync` (node:fs) | stderr 同步落盘 |
| 5.1% | `SessionManager.query` | 会话查询 |
| 2.9% | `statistics/store.ts` 写入 | 统计缓冲冲刷 |
| 1.5% | `better-sqlite3 transaction` | 事务包装 |
| 4.8% | `node:inspector post` | **profiler 自身,不算框架** |

按模块汇(typical 窗口忙时):消息处理链 20.4% / 身份库 18.9% / 日志 14.5% / Bot 6.4% / `node:fs` 5.4% / 会话库 5.1% / `node_modules`(better-sqlite3)3.3% / 统计 2.9%。同一套装配在 burst 档里 `node_modules` 涨到 **22.2%**——因为稳态档那部分 SQL 重编译的时间被折叠进了调用方的原生耗时里(`getUnion` 原生 245.8 ms、`_logMessage` 原生 324.1 ms),看不见但一样在付。

### 5.2 各装配的每消息成本(同档 800 msg/s,`results-prof.json`,忙比×窗口/送达)

| 场景 | µs/消息 | 相对 core 的增量 |
| --- | ---: | --- |
| core | 376 | — |
| stats | 436 | **+60 µs**:统计模块 |
| typical | 411 | 业务插件+回复+指令(与 stats 同量级,差异在噪声内) |
| quiet | 246 | **typical − quiet ≈ 165 µs/消息** = 每消息日志的代价(约占典型链 40%) |
| identity | 592 | 换成"热库身份"(平台 id 直接用账号 uuid,`account_map` 因此多一倍映射行)后整链 +180 µs;两条路径的 DB 操作结构相同,这 180 µs 只作为观测记名,机制未定论 |
| fresh | 1598 | 新用户+新会话落账,**约 8 倍 core** |

### 5.3 fresh 的画像(burst 之外唯一值得记名的第二瓶颈)

`gen mean 2.84 ms/条`(压测台侧 `user.get`+`session.get` 的全新账号路径),窗口 8 s 里忙时 7601 ms/8146 ms——**几乎全程在跑 JS**,而 CPU 数字上不去是因为被堵的墙钟不算 CPU。新用户路径每条要:

1. `UserManager.get` 开一个事务(`db.transaction(...)` 每次调用都新建),全新账号这条路径要点 5 次 `prepare()`:查映射(未命中)→ `INSERT OR IGNORE` → 再查 → 查 `internal_map` → 再 `INSERT OR IGNORE`;
2. `SessionManager.get` 同样一套;
3. `UserProfileManager.touch` 又一次 `prepare()` + upsert(名字未变时才走缓存短路)。

结果:100 msg/s 的新用户流入就足以让事件循环 p99 到 243 ms。

### 5.4 其余场景的忙时 Top(同一档 800 msg/s)

| 场景 | 忙时 Top(占忙比,括号内为该函数名下的原生耗时) | 读出来的东西 |
| --- | --- | --- |
| core | `_logMessage` 27.3%(原生 401 ms)、`write` 17.9%、`getUnion` 12.9%、`writeSync` 6.9%、`prepare` 5.3% | 没有统计、没有业务插件,链上仍然只有一件事:日志 |
| stats | `getUnion` 15.9%、`write` 13.9%、`query`(user)13.7%、`query`(session)13.6%、`writeSync` 7.7%、统计写入 4.1% | 统计自己的冲刷只占 4.1%,身份查询比它贵 4 倍 |
| quiet | `getUnion` 21.1%、`_logMessage` 19.3%(原生 136 ms)、`recordSend` 9.9%、`prepare` 7.8%、统计写入 6.2% | 级别调到 warn 后日志不再落屏,但 `_logMessage` 的两次查询+拼装照旧付——**这就是那条建议 2 的证据** |
| identity | `_logMessage` 20.2%(原生 521 ms)、`getUnion` 16.1%(原生 449 ms)、`write` 10.2%、`prepare` 6.9%、`sqliteTransaction` 4.6%、`rowFactory` 4.4% | 模块占比:`node_modules` 19.2%(SQLite 绑定层)、消息链 20.7%、身份库 16.1% |
| fresh | `sqliteTransaction` **44.5%**(原生 3366 ms)、`touch` 12.2%(原生 912 ms)、`_logMessage` 7.8%、`get` 事务体 7.5%、`session.get` 事务体 5.2% | 时间几乎全在同步事务里,JS 层看起来"没干什么活" |
| burst | `prepare` **17.9%**(原生 290 ms)、`getUnion` 15.1%、`write` 12.0%、`writeSync` 7.0%、`recordSend` 6.9%、`open` 4.2% | 满载时 SQL 重编译是第一大开销(模块口径:`node_modules` 22.2%) |

## 6. 建议(按性价比排序)

1. **缓存 prepared statement(最高收益,改动最小)。** 身份/会话层几乎每个方法都现场 `db.prepare(sql)`,让 V8 每条消息重编译一遍 SQL。热点就在 `user-manager.ts`:`getUnion`(:277,一次调用 4 个 `prepare`)、`get`(:106,`db.transaction(...)` 每次新建,命中 2 个 / 新建账号 5 个 `prepare`)、`query`(:234)、`has`(:145,一个 EXISTS 查询也要包事务),`session-manager.ts`(`get` :43、`query` :106)与 `user-profile.ts`(`touch`)同构。实测各场景 `prepare` 自身的忙时占比:burst **17.9%**、quiet 7.8%、identity 6.9%(另有 `sqliteTransaction` 4.6%、`rowFactory` 4.4%)、core 5.3%,fresh 里 `prepare` 只占 2.6% 但整个同步事务占 **44.5%**;稳态档(800 msg/s)这一项往往不单独显形,而是折进 `getUnion`(原生 245.8 ms)和 `_logMessage`(原生 324.1 ms)的原生耗时里。把这些语句提到实例字段(或一个 `stmt(sql)` 记忆化小工具),事务闭包在构造时建好而不是每次包。预期在满载档拿回 ~18% 忙时,并显著压低 fresh 的阻塞。
2. **让级别判断走在拼装之前,并考虑批量/异步写日志。** `MessageHandler._logMessage`(src/bot/message-handler.ts:44)无条件做两次查询(`user.query`/`session.query`)+ 字符串拼装,才交给 `logger.log` 去判级别;级别调到 warn 时这些钱照样花(quiet 场景 `_logMessage` 仍占忙时 19.3%)。给 logger 加 `isEnabled("log")` 之类的短路,`_logMessage` 整个跳过;控制台写可合并/走异步流。**预期收益 ~165 µs/消息(≈40% 链路开销)**,`fresh`/`identity` 一并受益。
3. **给"身份/会话查询"加内存缓存。** 真实群里绝大多数消息来自已见过的用户:`getUnion`(每条消息必调)和 `query`(日志那一调)现在每次都下 SQLite,`get`(新用户路径)更是每条一个事务。在 `UserManager`/`SessionManager` 上叠一层 LRU(键 `platform:id` → uuid,键 accountId → unionId),把热路径变成纯内存命中,冷启动/首次出现再落库。
4. **首条消息的落账别在主线程做。** 若 1、3 之后 fresh 仍然吃紧,把新用户/新会话的 INSERT 排进统计模块那种缓冲+批量冲刷(它已经验证过很便宜:+60 µs/消息、空转 0%),或放到 `setImmediate` 之后,避免堵住事件循环。
5. **顺手收紧一个释放顺序问题**(与性能无关但同批发现,见 §7)。
6. **不必动的:** 统计模块(便宜、空转 0%、无泄漏)、异步 handler 分发(在途有界,12 条),服务插件过滤器(permission 在链上没显出可测成本)。

## 7. 附带发现:释放链与一个顺序隐患

- **释放是干净的。** 新增 `--leak-check`:装配 → 静置 → 按正常顺序 `bot.dispose()` + `core.close()` → **立刻删沙盒目录** → 再静置。3 轮的"释放前 → 删目录后"静置 CPU 是 `0.0% → 4.2%`、`0.0% → 0.0%`、`0.0% → 0.0%`,全部判为干净(那 4.2% 是外部抢占,若是残留监听会稳定烧在 ~100% 单核)。读代码也一致(`ConfigStore.close()` 关 watcher、`Bot.dispose()` 关 state+settings、`BotManager.dispose()` 遍历全部 Bot)。
- 为什么专门查这个:Windows 上 `fs.watch` 的目录被删而监听未关,会让进程**永久烧掉一个核**(隔离复现:删目录 99% → 关监听 0%)。压测早先的空转 CPU 就是这个引起的,而**根因在压测台**——手工 `new Bot()` 不在 `BotManager` 名下,`core.close()` 不会替它 `dispose()`;框架自身没有这个漏。已在压测台修正(显式 `bot.dispose()`,且沙盒目录延后到收尾再删)。
- 仍建议收紧的一点:`Core.close()`(src/core.ts:293-301)把 `internalDB?.close()` 放在 `bot.dispose()` / `services.dispose()` **之前**,且几步共用同一个 try。若前一步抛错,后面的监听释放会被整段跳过——在本机这个 OS 行为下,那正是"永久烧核"的入口。建议每步各自 try/catch(或先停 Bot/服务,再关库)。

## 8. 复现

```bash
# 完整阶梯(8 场景, 9 档速率, 约 15~20 分钟)
node --import tsx scripts/bench/bench-message.ts --out=data/bench/results-final.json

# 分层归因用的窗口 profile(同档 800 msg/s × 8s, 7 份 cpuprofile)
node --import tsx scripts/bench/bench-message.ts \
  --scenarios=core,stats,typical,quiet,identity,fresh,burst \
  --ladder=800 --step=8 --warmup=1 --cpu-prof=data/bench/prof3 --out=data/bench/results-prof.json

node scripts/bench/summarize-cpu-profile.mjs data/bench/prof3/typical.cpuprofile --top=20

# 监听泄漏体检 / 静置探针
node --import tsx scripts/bench/bench-message.ts --leak-check --probe-rounds=3 --probe-window=3 --scenarios=core
node --import tsx scripts/bench/bench-message.ts --probe --scenarios=stats
```

原始数据:`data/bench/results-final.json`(阶梯)、`data/bench/results-prof.json`(profile 窗口)、`data/bench/prof3/*.cpuprofile`。压测台与被测框架的接口只有 `Bot.dispatch(event, meta)` 和适配器动作回调,口径就是"平台数据已到手之后"。

## 9. 局限

- 不含网络收包/反序列化/适配器自身逻辑,也不含 WebUI 与日志持久化管道;真实 Bot 的适配器可能是另一个量级的大头。
- 单机单进程、SQLite 在临时目录;夹具插件只做 ack,没有真实平台的限流与重试。
- 外部抢占(Qoder ~1.4 核)贯穿全程,跨场景的中等差异不可分辨;忙时占比与 burst 天花板两项受此影响最小。
- 每场景只跑一轮阶梯(约 5 s/档),没有长跑稳定性/内存泄漏观测;`fresh` 的绝对数字受表行数增长影响(窗口内表一直变大),报告只取"新用户落账很贵"这个方向性结论。
- CPU profile 自身有开销:§5.2 那一列(376~1598 µs/消息)只能横向比较,不能与 §4.1 无 profiler 的数字混用。
