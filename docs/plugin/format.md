# 插件的格式

## 文件结构

插件必须包含以下文件:

- `manifest.json`: 插件的元数据文件，包含插件的名称、版本、作者等信息。

- 任意js/ts文件: 
  - 入口文件: 即manifest.json中`main`字段指定的文件, 该文件必须导出一个对象, 对象中必须包含`init(ctx)`方法, 可选包含`unload(ctx)`, `error(ctx)`方法
  - 其他文件: 插件可以包含任意js/ts文件, 这些文件可以被入口文件或其他文件导入使用

## 清单文件

清单文件必须是有效的json5格式, 并且必须包含以下字段:

| 字段 | 类型 | 必填 | 说明 |
| ---|---|---|---|
| `id` | string | 是 | 插件的唯一标识符, 通常由小写字母, 数字, 连字符组成, 例如`my-plugin` |
| `main` | string | 是 | 插件的入口文件, 相对于插件根目录的路径, 例如`index.js` |
| `version` | string | 是 | 插件的版本号, 遵循语义化版本规范, 例如`1.0.0` |
| `type` | string | 否 | 插件的类型, 可选值为`adapter`或`normal`, 默认为`normal` |
| `name` | string | 否 | 插件的名称, 用于展示给用户, 例如`My Plugin` |
| `author` | string | 否 | 插件的作者, 用于展示给用户, 例如`Baka Cirno` |
| `description` | string | 否 | 插件的描述, 用于展示给用户, 例如`This is my plugin` |
| `dependencies` | object | 否 | 插件的依赖关系, 键为依赖插件的id, 值为依赖插件的版本号, 例如`{"other-plugin": ">1.0.0"}` |
| `config` | string | 否 | 配置生成文件, 相对于插件根目录, 例如`config.json`。该文件同时提供控件定义与默认值;` |

## 入口文件

入口文件必须默认导出一个对象, 称为**插件模块**

插件模块必须包含`init(ctx)`方法, 该方法在插件被启用时调用, 用于初始化插件

插件模块也支持可选的以下方法:

- `unload(ctx)`: 当插件被卸载时调用, 用于清理插件资源

- `error(e)`: 当插件在运行时发生错误时调用, 用于处理插件错误

上面三个方法均可以为异步函数

入口文件可以导入其目录下的其他文件, 也可以导入npm包

## 配置生成文件

该文件为JSON文件, 用于WebUI前端生成表单控件及后端值校验

该JSON的Schema文件在`/src/config/schema.json`, 也可以查看[Config生成文件](../schemas/config.md)定义

## 模板

**manifest.json**
```json
{
	"id": "example",
	"version": "0.0.0",
	"name": "Example Plugin",
	"author": "Someone",
	"main": "index.js",
	"config": "config.json",
	"dependencies": {
		"other": "any"
	}
}
```

**入口文件 (`index.js`)**
```javascript
export default {
	init(ctx) {
		// 初始化插件
	},
	unload(ctx) {
		// 清理插件资源
	},
	error(e) {
		// 处理插件错误
	}
};
```

**配置生成文件 (config.json)**
```json
{
	"controls": [
		{
			"type": "input",
			"id": "name",
			"label": "名称",
			"default": "chirucat"
		}
	]
}
```