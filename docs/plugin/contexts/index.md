# 插件上下文

即框架为插件提供的上下文对象，插件可以通过该对象访问框架提供的功能和数据。

插件上下文仅在`init`方法和`unload`方法作为参数传入

在`unload`时, 上下文会尝试删除所有通过ctx产生的副作用

## 上下文对象

无论清单里是什么类型的插件, 均拥有`PluginContext`提供的功能

- [`PluginContext`](normal.md)

- [`AdapterContext`](adapter.md)