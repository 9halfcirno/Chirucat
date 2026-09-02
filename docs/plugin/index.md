# Chirucat插件

**Chirucat插件**, 即为框架提供具体功能的模块, 也可以让框架接入不同的聊天平台

## 概述

插件是Chirucat的核心部分, 既可以通过插件来扩展框架的功能, 也可以通过插件来接入不同的聊天平台。插件由两部分组成：

- **`manifest.json`**：插件清单，声明插件 ID、版本、入口文件等
- **入口模块**：默认导出一个 `{ init(ctx), unload?(ctx) }`

## 插件的两种类型

插件分为两类:

- **适配器插件**：用于接入不同的聊天平台, 例如QQ, 微信, Discord等
- **功能插件**: 用于为Bot添加不同的功能, 如响应命令/消息等

---

## 插件开发

Chirucat插件系统使用**esbuild**对插件代码进行打包, 因此插件开发语言可使用任意esbuild支持的语言, 例如TypeScript, JavaScript, JSX, TSX等

### 文档

- [插件开发准则](guidelines.md)
- [插件格式](format.md)
- [插件上下文](./contexts/index.md)