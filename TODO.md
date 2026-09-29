# Chirucat 待办列表

标为已完成的会在todo几次更新后消失!, 越往前代表越重要

- [x] 实现`service`类型插件支持, 使繁重的服务插件在全局插件目录时作为"基础设施"保持全局单例, 而非每个bot均实例化一份

  - [ ] 将 bind/黑白名单 提取为service插件

- [x] ~~将Bot配置的`config.json`与`state.json`合并~~ 已否决: 配置(用户意图, 一个文件)与状态(期望态, 一个文件)语义不同, 合并会让"收敛运行态"反过来污染用户偏好

- [ ] 添加更多事件支持

- [ ] WebUI可用化

  - [x] Bot设置管理

  - [x] 实装设置页面

- [x] Core / 统计 / WebUI 配置接入设置层(定义驱动, 见 docs/schemas/settings.md)

- [ ] 让 app.ts 直接经设置域读启动参数, 取代 readJSONOrCreate