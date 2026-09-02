# Entity对象

## 概述

该对象通常以BotEvent为数据源创建, 为业务实体, 插件能接触到的很多回调参数均为`Entity`子类

## 结构

### 字段

- `uuid`: 实体uuid
- `type`: 该实体的类型, 为BotEvent中的类型
- `time`: 该实体/源事件创建时间
- `platform`: 该实体的源事件来源平台

- `meta`: 源事件的元信息, 如来源适配器标识等
- `extra`: 适配器传入的额外信息, 一般用于适配器实现双向通信所需的内容, 使用`Entity.action`方法时会传回适配器, 一般插件不应依靠或修改该字段

### 方法

- `action(action: BotAction): Promise<void>`: 通过该实体向适配器