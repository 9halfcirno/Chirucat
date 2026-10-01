# Chirucat 待办列表

标为已完成的会在todo几次更新后消失!, 越往前代表越重要

- [x] 实现`service`类型插件支持, 使繁重的服务插件在全局插件目录时作为"基础设施"保持全局单例, 而非每个bot均实例化一份

  - [x] 将 bind/黑白名单 提取为service插件

    - [x] 黑白名单 → `services/filter`: 名单存储、判定(事件过滤器)、WebUI 端点与静态资源全归插件, 框架侧不再有名单语义
    - [x] WebUI 开放服务插件运行期路由注册: 端点在 `/service/<插件id>/api/<路径>`, 插件自带静态资源在 `/service/<插件id>/public`
    - [x] 让 WebUI 前端能从服务插件的 `/service/<插件id>/public` 加载页面, 再把黑白名单页面从核心前端搬进 `services/filter/public`(端点 `/api/get_webui_pages` + `ctx.core.webui.pages.register` / `bot.pages.register`, 前端按清单对账, 停用即从导航消失)
    - [ ] `data/internal.db` 里遗留的 `filter_list` 表已废弃(框架不再读写它), 确认不需要旧数据后可手工删除
    - [ ] (可选) 给 `services/` 单独一份 tsconfig, 让服务插件代码也进 `check:types`(现在与普通插件一样不在 `src/**` 检查范围内)

- [x] ~~将Bot配置的`config.json`与`state.json`合并~~ 已否决: 配置(用户意图, 一个文件)与状态(期望态, 一个文件)语义不同, 合并会让"收敛运行态"反过来污染用户偏好

- [ ] 添加更多事件支持

- [ ] WebUI可用化

  - [x] Bot设置管理

  - [x] 实装设置页面

- [x] Core / 统计 / WebUI 配置接入设置层(定义驱动, 见 docs/schemas/settings.md)

- [ ] 让 app.ts 直接经设置域读启动参数, 取代 readJSONOrCreate