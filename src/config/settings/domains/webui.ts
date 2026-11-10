import path from "node:path";
import { defaultsOf } from "../../schema";
import type { ConfigRoot } from "../../types";
import { root } from "../../../utils/root";
import { uuid } from "../../../utils/uuid";

/** WebUI 设置域 id (注册到 SettingsManager 时使用) */
export const WEBUI_DOMAIN_ID = "webui";

/**
 * WebUI 设置值文件
 *
 * 启动 WebUIServer 时直接把这份设置展开成构造参数: schema 里的键必须与
 * `WebUIServerOptions` 逐字对齐, 否则会出现"写进去的字段启动时读不出来"。
 */
export const WEBUI_SETTINGS_FILE = path.resolve(root, "configs", "webui.json");

/** WebUI 设置的形状 (运行时由 schema 保证, 这里只给调用方一个可读的类型) */
export interface WebUISettings extends Record<string, unknown> {
	password: string;
	port: number;
	host: string;
	localNoAuth: boolean;
	frontConfig: {
		enableTestLab: boolean;
		/** 界面风格; 值文件里缺省时由 schema 补 "vsc" */
		uiStyle?: "vsc" | "md3" | "winui";
	};
}

/**
 * WebUI 设置 schema
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
export const webuiSettings: ConfigRoot = {
	version: "1.0.0",
	controls: [
		{
			type: "input",
			id: "password",
			label: "访问密码",
			default: "",
			secret: true,
			placeholder: "留空表示不修改",
			desc: "留空表示不修改; 修改后所有已登录会话立即失效, 需要重新登录",
		},
		{
			type: "switch",
			id: "localNoAuth",
			label: "本机访问无需密码",
			default: false,
			desc: "开启后, 从本机 (127.0.0.1) 打开的页面不再要求登录; 局域网访问仍需密码。只在监听地址不是仅本机时才有意义",
		},
		{
			type: "input",
			id: "port",
			label: "监听端口",
			default: 7636,
			valueType: "number",
			min: 1,
			max: 65535,
			integer: true,
			desc: "保存后立即换到新端口; 当前页面会断开, 需要用新地址重新访问",
		},
		{
			type: "input",
			id: "host",
			label: "监听地址",
			default: "127.0.0.1",
			placeholder: "127.0.0.1",
			desc: "127.0.0.1 仅本机可访问, 0.0.0.0 表示所有网卡; 保存后立即生效",
		},
		{
			type: "group",
			id: "frontConfig",
			label: "前端",
			desc: "下发给 WebUI 前端的开关, 保存后立即生效",
			controls: [
				{
					type: "select",
					id: "uiStyle",
					label: "界面风格",
					default: "vsc",
					items: [
						{ label: "VS Code 风格", value: "vsc" },
						{ label: "Material 3 风格", value: "md3" },
						{ label: "WinUI 风格", value: "winui" },
					],
					desc: "WebUI 的视觉风格; 明暗仍由顶栏按钮或系统偏好决定。保存后立即生效, 对所有访问者生效",
				},
				{
					type: "switch",
					id: "enableTestLab",
					label: "测试实验室",
					default: false,
					desc: "在活动栏显示测试页, 供接口调试用; 保存后页面立即增删",
				},
			],
		},
	],
};

/**
 * 生成 WebUI 值文件的初始内容 (文件首次创建时用)
 *
 * 密码必须每次安装都不同(随机串), 因此不能写进 schema 的 `default` —— 那里
 * `password.default: ""` 表达的是**运行期**语义(空串 = 不鉴权, 见
 * `WebUIServer.updateSecurity`), 与"首次该生成什么"是两回事。本函数是
 * "首次生成"的唯一真相源: 设置域在值文件缺失或损坏重建时都调它,
 * 只会落盘一份带随机密码的配置 —— 不会出现
 * "空密码 + 全网卡监听"的裸奔管理后台。
 *
 * 其余字段直接取 schema 的默认值, 字段增减时只需改 schema。
 */
export function initialWebUISettings(): WebUISettings {
	return {
		...defaultsOf(webuiSettings),
		password: uuid().replaceAll("-", "").slice(0, 10),
	} as WebUISettings;
}
