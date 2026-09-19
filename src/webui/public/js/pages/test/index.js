import { createConfigList } from "../../spa/components/config-editor.js";

export default {
	id: "test",
	title: "测试页面",

	/**
	 * 
	 * @param {HTMLDivElement} container 
	 */
	render(container) {
		let config = createConfigList({
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
					"default": 10,
					"desc": "控制回复延迟"
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
							"type": "group",
							"id": "pro-group-group",
							"label": "高级设置",
							"controls": [{
								"type": "input",
								"id": "extra",
								"label": "额外参数",
								"default": "--max_msgs 10"
							}],
						},
						{
							"type": "table",
							"id": "group-controls",
							"label": "群组控制",
							"default": [ // 初始行数据, 未提供时表格只有表头
								{
									"enable": true,
									"mode": "passive"
								}
							],
							"controls": [ // 表内控件的 id 只在行内作用域可见
								{
									"type": "switch",
									"id": "enable",
									"label": "启用",
									"default": false
								}, {
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
									"type": "select",
									"id": "mode",
									"label": "模式",
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
		});

		container.append(config.el);
	},
};
