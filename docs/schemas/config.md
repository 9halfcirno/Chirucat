# Config生成文件

## 概述

该文件用于WebUI生成配置表单控件及值校验等, 具体Schema文件在[Config Schema](/src/config//schema.json)

## 结构

该JSON对象顶层应包含以下字段

- `controls`: [控件](#控件)数组

## 控件

所有控件均拥有以下字段

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `type` | `string` | 是 | 表示控件类型 |
| `id` | `string` | 是(除`text`外) | 控件id, 即配置项键名 |
| `label` | `string` | 是(除`group`外) | 控件标签, 为了用户可读性该值在定义上为必填, 显示在控件上方 |
| `default` | 依控件而定, 为控件产出值的类型 | 否(一般建议当作"**是**") | 控件默认值 |
| `required` | `boolean` | 否 | 控件是否为必填项, 默认非必填 |
| `desc` | `string` | 否 | 控件小字描述, 显示在控件下方 |
| `visible` | [`Expr`](#expr表达式) | 否 | 控制控件要显示的满足条件, 不填则为始终显示 |

### 输入框控件

**type**为`"input"`

**产出值**为`string`类型

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `placeholder` | `string` | 否 | 输入框为空时的占位 |
| `attr` | `Record<string, any>` | 否 | 输入框input属性, 为额外HTMLInputElement属性 |



### 文本框控件

**type**为`"textarea"`

**产出值**为`string`类型

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `placeholder` | `string` | 否 | 文本框为空时的占位 |
| `rows` | `number` | 否 | 文本框初始可见行数 |
| `attr` | `Record<string, any>` | 否 | 文本框textarea属性, 为额外HTMLTextareaElement属性 |

### 开关控件

**type**为`"switch"`

**产出值**为`boolean`类型

*该控件无额外字段*

### 选择框控件

**type**为`"select"`

**产出值**为`(typeof items)[number][]`类型, 即为`items`数组项构成的子数组

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `items` | `(string \| number \| boolean)[]` | 是 | 可选值列表 |

### 复选框控件

**type**为`"checkbox"`

**产出值**为`(typeof items)[number]["value"][]`类型, 即为`items`数组项的`value`值构成的子数组

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `items` | `{ label: string, value: (string \| number \| boolean) }[]` | 是 | 可复选值列表 |

### 滑块控件

**type**为`"slider"`

**产出值**为`number`类型

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `min` | `number` | 是 | 滑块最小值 |
| `max` | `number` | 是 | 滑块最大值 |
| `step` | `number` | 是 | 滑块步长 |

### 文本控件

**type**为`"text"`

*该控件无产出值*

*该控件无额外字段*

## 结构控件

该类控件为结构性控件, 同属于控件, 包含控件组和控件列表

> 请不要在结构控件内套娃! 以免造成显示问题

### 控件组

该控件用于控件分组, 如批量控制控件可见性或结构化配置数据等

**type**为`"group"`

**产出值**为`Reocrd<string, unknown>`, 即组内所有控件的产出值字典

内部控件的id会映射为`${groupId}.${id}`, 如`settings.command`(表示设置组的id="command"的控件)

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `controls` | [`Control[]`](#控件) | 是 | 组内控件 |

### 控件列表

该控件用于动态生成多个相同控件组(即多项相同配置)

**type**为`"table"`

**产出值**为`Reocrd<string, unknown>[]`, 即表内所有控件组的产出值

内部控件的id会被映射为`${tableId}.${idx}.${id}`, 如`lists.0.name`(表示列表第0项的id="name"的控件)

| 属性 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `controls` | [`Control[]`](#控件) | 是 | 组内控件 |

### Expr表达式

该对象表示布尔表达式, 用于控制控件可见性

**必填字段**
- `op`: 枚举类型, 支持以下值
	- "and": 逻辑与
	- "or": 逻辑或
	- "not": 逻辑非
	- "equal": 判断相等
	- "notEqual": 判断不等
	- "in": 判断存在
	- "notIn": 判断不存在
	- "gt"
	- "gte"
	- "lt"
	- "lte"

当`op`为以下值`and`, `or`的必填项
- `left`: 左表达式
- `right`: 右表达式

当`op`为以下值`not`的必填项
- `left`: 要取反的表达式

当`op`为以下值`in`, `notIn`时的必填项
- `target`: 目标数组
- `ref`: 控件产出值的引用, 值为目标控件id

当`op`不为上述任何值时的必填项
- `ref`: 控件产出值的引用, 值为目标控件id
- `target`: 目标值


## 示例JSON

以下JSON构建了一个包含所有控件的配置表单, 包含文本/滑块/复选框以及控件组和控件列表等

```jsonc
{
	"$schema": "./schema.json",
	"controls": [
		{
			"type": "input",
			"id": "name",
			"label": "名字",
			"default": "uk",
			"required": false
		},
		{
			"type": "textarea",
			"id": "intro",
			"label": "简介",
			"default": "",
			"placeholder": "支持多行输入",
			"rows": 3,
			"desc": "换行会被原样保留; 右下角可纵向拉伸"
		},
		{
			"type": "switch",
			"id": "enable",
			"label": "启用",
			"default": false
		},
		{
			"type": "select",
			"id": "sex",
			"label": "选择",
			"items": [
				{
					"label": "主动",
					"value": "active"
				},
				{
					"label": "被动",
					"value": "passive"
				}
			],
			"default": "active"
		},
		{
			"type": "checkbox",
			"id": "features",
			"label": "功能",
			"items": [
				{
					"label": "发送消息",
					"value": "msg"
				},
				{
					"label": "发送表情",
					"value": "emoji"
				}
			],
			"default": [
				"msg"
			]
		},
		{
			"type": "slider",
			"id": "offset",
			"label": "延迟",
			"min": 0,
			"max": 100,
			"step": 1,
			"default": 10
		},
		{
			"type": "switch",
			"id": "pro",
			"label": "高级选项",
			"default": false
		},
		{
			"type": "group",
			"id": "pro-group",
			"label": "高级设置",
			"controls": [
				{
					"type": "input",
					"id": "extra",
					"label": "额外参数",
					"default": "--max_msgs 10"
				},
				{
					"type": "table",
					"id": "group-controls",
					"label": "群组控制",
					"default": [ // 初始行数据, 未提供时表格只有表头
						{
							"enable": true,
							"mode": "active"
						}
					],
					"controls": [ // 表内控件的 id 只在行内作用域可见
						{
							"type": "switch",
							"id": "enable",
							"label": "启用",
							"default": false
						},
						{
							"type": "select",
							"id": "mode",
							"label": "选择",
							"items": [
								{
									"label": "主动",
									"value": "active"
								},
								{
									"label": "被动",
									"value": "passive"
								}
							],
							"default": "active"
						}
					]
				}
			],
			"visible": {
				"op": "and",
				"left": {
					"op": "equal",
					"ref": "pro",
					"target": true
				},
				"right": true
			}
		}
	]
}
```