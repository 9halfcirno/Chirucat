import type { Message } from "../../src/entity/message";
import type { PluginContext } from "../../src/plugin/contexts/context";

/** 指令处理函数 */
type MessageHandler = (
	msg: Message | null,
	args: (string | number)[]
) => void | Promise<void>;

/** `ctx.command.register` 的返回类型 */
type CommandHandle = Parameters<PluginContext["command"]["unregister"]>[0];

/** 框架尚未写入文档、但实际存在的字段 */
type PermissibleSender = { permission?: number };

/** reply / message.send 的响应形状 (成功时带 id, 失败时带 code / error) */
type SendResult = {
	success: boolean;
	id?: string;
	code?: string;
	error?: string;
};

// 模块级状态 —— 每 Bot 一份模块实例, 与 init/unload 成对
/** 本插件创建的定时器, unload 时统一清理 */
const timers = new Set<ReturnType<typeof setTimeout>>();

export default {
	init(ctx: PluginContext) {
		// ==================== 子命令路由表 ====================
		// key = 子命令名; feature = 在 config.features 里对应的复选框 value
		const routes: Record<
			string,
			{ feature: string; handler: (msg: Message, args: (string | number)[]) => Promise<void> }
		> = {
			reply: {
				feature: "reply",
				handler: async (msg) => {
					await msg.reply(
						`测试引用回复: \n- 消息ID: ${msg.id}\n- 引用Token: ${msg.token}`,
						{ quote: true }
					);
				},
			},

			delete: {
				feature: "delete",
				handler: async (msg) => {
					const res = (await msg.reply(
						`测试撤回: \n该消息将在 5s 后尝试撤回!`
					)) as SendResult;
					if (!res.success) {
						await msg.reply(
							`无法进行撤回: message.send响应失败: ${res.error}`
						);
						return;
					}

					const id = res.id!;
					const timer = setTimeout(() => {
						timers.delete(timer);
						msg
							.action({
								type: "message.delete",
								session: msg.session.id,
								id,
							})
							.catch((err) =>
								ctx.logger.warn(
									`测试撤回失败: ${(err as Error).message}`
								)
							);
					}, 5000);
					timers.add(timer);
				},
			},

			permission: {
				feature: "permission",
				handler: async (msg) => {
					const level = (msg.sender as PermissibleSender).permission ?? 0;
					await msg.reply(`当前权限等级为 ${level}`);
				},
			},
		};

		// 富媒体子命令共用一个 handler, 统一归属 "media" 开关
		for (const kind of ["image", "video", "audio"] as const) {
			routes[kind] = {
				feature: "media",
				handler: async (msg) => {
					const url = ctx.config.get(`mediaUrl.${kind}`) as string | undefined;
					if (url) {
						const res = (await msg.reply([{ type: kind, url }])) as SendResult;
						if (!res.success) {
							await msg.reply(
								`发送失败: ${res.code ?? "NULL_CODE"}: ${res.error}`
							);
						}
						return;
					}

					// 未配置链接: 回退到插件自带的本地图片(Buffer 发送)
					const buffer = (await ctx.plugin.read("assets/test.png")) as Buffer;
					const res = (await msg.reply([
						{ type: "image", buffer },
					])) as SendResult;
					if (!res.success) {
						await msg.reply(
							`本地图片(Buffer)发送失败: ${res.code ?? "NULL_CODE"}: ${res.error}`
						);
						return;
					}
					await msg.reply(`图片Buffer发送完成!\nmsg_id: ${res.id}`);
				},
			};
		}

		// ==================== 主指令处理 ====================
		const mainHandler: MessageHandler = async (msg, args) => {
			if (!msg) return;
			if (ctx.config.get("enable") === false) return;

			const features =
				(ctx.config.get("features") as string[] | undefined) ?? [];

			// 无参数: 打印概览
			if (!args?.length) {
				await msg.reply(
					`## 测试:\n\n` +
					`- 当前测试指令: /${ctx.config.get("command")}\n` +
					`- 启用的测试功能: \n  - ${features.join("\n  - ") || "无"}`
				);
				return;
			}

			// 子命令分派
			const sub = String(args[0]);
			const route = routes[sub];
			if (!route) return;
			if (!features.includes(route.feature)) return;

			await route.handler(msg, args);
		};

		// ==================== 高权限演示指令 ====================
		const highHandler: MessageHandler = (msg, args) => {
			if (!msg) return;
			const level = (msg.sender as PermissibleSender).permission ?? 0;
			const required = readLevel(ctx, "highCommand.level", 1);
			msg.reply(
				`该指令所需等级为 ${required}, 调用等级为 ${level}\n\n参数列表: ${args.join()}`
			);
		};

		// ==================== 可换绑指令管理 ====================
		type Binding = {
			/** 该绑定关心的配置键, 任一变更即重新注册 */
			configKeys: readonly string[];
			/** 从配置里读当前的名字与注册选项 */
			resolve: () => { name: string; options?: Record<string, unknown> };
			handler: MessageHandler;
			handle: CommandHandle | null;
		};

		const bindings: Binding[] = [
			{
				configKeys: ["command"],
				resolve: () => ({
					name: String(ctx.config.get("command") || "test"),
				}),
				handler: mainHandler,
				handle: null,
			},
			{
				configKeys: ["highCommand.name", "highCommand.level"],
				resolve: () => ({
					name: String(ctx.config.get("highCommand.name") || "high_test"),
					options: { permission: readLevel(ctx, "highCommand.level", 1) },
				}),
				handler: highHandler,
				handle: null,
			},
		];

		const applyBinding = (b: Binding) => {
			const { name, options } = b.resolve();
			if (!name) return;
			if (b.handle) ctx.command.unregister(b.handle);
			// `permission` 是框架支持但文档未收录的注册选项, 加断言绕过类型检查
			b.handle = ctx.command.register(name, b.handler, options as never);
		};

		for (const b of bindings) applyBinding(b);

		ctx.config.watch((key, next, prev) => {
			if (next === prev) return;
			for (const b of bindings) {
				if (b.configKeys.includes(key)) {
					applyBinding(b);
					return;
				}
			}
		});
	},

	unload() {
		for (const t of timers) clearTimeout(t);
		timers.clear();
	},
};

/** 从配置里读一个权限等级, 非法值回退到 fallback */
function readLevel(ctx: PluginContext, key: string, fallback: number): number {
	const raw = ctx.config.get(key);
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.floor(n));
}