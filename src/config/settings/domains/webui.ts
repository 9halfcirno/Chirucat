import path from "node:path";
import { root } from "../../../utils/root";
import { uuid } from "../../../utils/uuid";
import { defaultsOf } from "../compile";
import { defineSettings } from "../define";
import type { SettingsDefinition } from "../types";

/** WebUI 设置域 id (注册到 SettingsManager 时使用) */
export const WEBUI_DOMAIN_ID = "webui";

/**
 * WebUI 设置值文件
 *
 * 与 `app.ts` 读取的是同一份文件: 定义里的键必须与 `WebUIServerOptions`
 * 逐字对齐, 否则会出现"写进去的字段启动时读不出来"。
 */
export const WEBUI_SETTINGS_FILE = path.resolve(root, "configs", "webui.json");

/** WebUI 设置的形状 (运行时由定义保证, 这里只给调用方一个可读的类型) */
export interface WebUISettings extends Record<string, unknown> {
	password: string;
	port: number;
	host: string;
	localNoAuth: boolean;
	frontConfig: {
		enableTestLab: boolean;
	};
}

/**
 * WebUI 设置定义
 *
 * 全部项都是**热生效**的:
 * - `port` / `host` 由 `WebUIServer.relisten` 关旧监听、在新地址重开
 * - `password` 直接换内存里的校验值 (已签发的 token 会立刻失效, 那是预期的安全行为)
 * - `localNoAuth` / `frontConfig` 都是内存开关
 *
 * 所以这里没有任何 `restart` 项 —— 设置页不会提示"请重启 Core"。
 *
 * 注意 password 标了 `secret`: 对外读取时脱敏为空串, patch 里空串表示
 * "不修改"、null 表示"清除"。
 */
export const webuiSettings: SettingsDefinition = defineSettings({
	version: "1.0.0",
	groups: {
		frontConfig: {
			label: "前端",
			desc: "下发给 WebUI 前端的开关, 保存后立即生效",
		},
	},
	fields: {
		password: {
			type: "string",
			default: "",
			secret: true,
			label: "访问密码",
			desc: "留空表示不修改; 修改后所有已登录会话立即失效, 需要重新登录",
		},
		localNoAuth: {
			type: "boolean",
			default: false,
			label: "本机访问无需密码",
			desc: "开启后, 从本机 (127.0.0.1) 打开的页面不再要求登录; 局域网访问仍需密码。只在监听地址不是仅本机时才有意义",
		},
		port: {
			type: "number",
			default: 7636,
			min: 1,
			max: 65535,
			integer: true,
			widget: "input",
			label: "监听端口",
			desc: "保存后立即换到新端口; 当前页面会断开, 需要用新地址重新访问",
		},
		host: {
			type: "string",
			default: "127.0.0.1",
			label: "监听地址",
			placeholder: "127.0.0.1",
			desc: "127.0.0.1 仅本机可访问, 0.0.0.0 表示所有网卡; 保存后立即生效",
		},
		"frontConfig.enableTestLab": {
			type: "boolean",
			default: false,
			label: "测试实验室",
			desc: "在侧栏显示 test 页, 供接口调试用",
		},
	},
});

/**
 * 生成 WebUI 值文件的初始内容 (文件首次创建时用)
 *
 * 密码必须每次安装都不同(随机串), 因此不能写进定义的 `default` —— 定义里
 * `password.default: ""` 表达的是**运行期**语义(空串 = 不鉴权, 见
 * `WebUIServer.updateSecurity`), 与"首次该生成什么"是两回事。本函数是
 * "首次生成"的唯一真相源: `app.ts` 启动建文件与设置域载入到缺失文件时
 * 都调它, 谁先跑都只会落盘一份带随机密码的配置 —— 不会出现
 * "空密码 + 全网卡监听"的裸奔管理后台。
 *
 * 其余字段直接取定义的默认值, 字段增减时只需改定义。
 */
export function initialWebUISettings(): WebUISettings {
	return {
		...defaultsOf(webuiSettings),
		password: uuid().replaceAll("-", "").slice(0, 10),
	} as WebUISettings;
}
