# Chirucat 待办列表

标为已完成的会在todo几次更新后消失!, 越往前代表越重要

## 基础设施

### 增加

- [x] 实现hook系统, 以使服务插件可干涉框架处理流程

- [ ] 添加更多事件/动作支持

- [ ] 添加适配器逃生舱, 使当框架协议不够用时可以直接利用平台原生能力

- [ ] **待规划**: WebUI添加插件市场

### 优化

- [ ] **待评估**: 让 app.ts 直接经设置域读启动参数, 取代 readJSONOrCreate

## 附属 - 服务插件

### 增加

- [ ] 实现权限管理服务

  - *基础设施 Hook 系统已就绪*

- [x] 将 bind/黑白名单 提取为service插件

  - [x] 黑白名单 → `services/filter`: 名单存储、判定(事件过滤器)、WebUI 端点与静态资源全归插件, 框架侧不再有名单语义
  - [x] WebUI 开放服务插件运行期路由注册: 端点在 `/service/<插件id>/api/<路径>`, 插件自带静态资源在 `/service/<插件id>/public`
  - [x] 让 WebUI 前端能从服务插件的 `/service/<插件id>/public` 加载页面, 再把黑白名单页面从核心前端搬进 `services/filter/public`(端点 `/api/get_webui_pages` + `ctx.core.webui.pages.register` / `bot.pages.register`, 前端按清单对账, 停用即从导航消失)

## 遗留/其他

- [ ] `data/internal.db` 里遗留的 `filter_list` 表已废弃(框架不再读写它), 确认不需要旧数据后可手工删除

- [ ] (可选) 给 `services/` 单独一份 tsconfig, 让服务插件代码也进 `check:types`(现在与普通插件一样不在 `src/**` 检查范围内)