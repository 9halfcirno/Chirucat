# Command对象

## 概述

该对象包含指令名和指令回调, 通常不应操作该对象

## 结构

### 字段

- `name`: 指令用于匹配的名字

### 方法

- `handler(msg: Message | null, args: (string | number)[])`: 指令回调