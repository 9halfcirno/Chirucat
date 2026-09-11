# Chirucat!

[English](./README.en.md)

> 跨平台的多Bot框架

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> 目前还在开发阶段, 暂未提供安装即用的功能，功能和用法会不断调整。
> 这个文档也会不断变动

---

## Chirucat 能做什么？

- **跨平台**：Bot可通过适配器在不同平台使用, 以及关联用户
- **多Bot**：可创建多个Bot以搭载不同插件, 实现互相独立的功能内容
- **插件即功能**：机器人的各自功能均由插件决定, 甚至出现在不同平台

## 快速开始

### 1. 安装 Node.js

到 [nodejs.org](https://nodejs.org) 下载并安装 LTS 版本。

### 2. 获取 Chirucat

获取项目代码（Git 克隆或 ZIP 解压），在项目文件夹里打开终端，执行：

```bash
npm install
```

### 3. 启动Chirucat

在项目根目录下运行

```bash
npm run app
```

等待一会儿就会在本地`http://localhost:7636`打开WebUI

### 4. 创建初始Bot

在WebUI中打开**bots**页面, 点击上方"+"号即可弹出Bot创建对话框并创建属于你的Bot

### 连接聊天平台

要让机器人上某个聊天平台，需要安装对应的「适配器」插件（由社区提供）。接入方法见对应插件的说明。

## 概念速览

| 名词 | 是什么 |
| --- | --- |
| 机器人（Bot） | 一个聊天机器人实例，有自己的名字和插件 |
| 插件 | 机器人的一项功能，装了就多一个本事 |
| 适配器 | 连接机器人和聊天平台的「桥梁」，每个平台一个 |

## 给开发者

想为 Chirucat 开发插件或适配器？请阅读[插件开发指南](docs/plugin/index.md)。

## 未来计划

详见[TODO](TODO.md)

## 许可证

[MIT](LICENSE) © 2026 9halfcirno
