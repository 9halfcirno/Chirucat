import path from "node:path";
import type { ServiceContext } from "../../src/plugin/services/context";
import type { ServiceModule } from "../../src/plugin/services/service";
import type { MessageCreateEvent } from "../../src/protocols/event/message";
import { createFilterHandler } from "./filter-api";
import { FilterManager } from "./filter-manager";

/**
 * 模块级状态
 *
 * 服务插件在整个进程里只有一份实例, 但模块契约把 `init(ctx)` 与 `unload(ctx)` 拆开,
 * 资源得有地方放(与 bind 用模块级 command 是同一做法)。停用会销毁模块, 重新启用时
 * 模块重新加载, 因此这里不会残留上一轮的实例。
 */
let manager: FilterManager | null = null;

/**
 * Chirucat 消息过滤服务 (黑白名单)
 *
 * 它是框架级基础设施: 名单的存储、判定与 WebUI 管理端点、自带静态资源全在这里,
 * 框架侧不再有任何名单语义。
 *
 * 判定发生在**事件传播阶段**(`ctx.event.filter`): 被拦下的事件不进入 Bot 的处理链,
 * 因此不会触发指令、插件回调, 也不会进统计 —— 日志是本插件自己记的, 那是唯一的
 * 可观测出口(见 logBlocked)。
 *
 * 每一层(全局 / 每个 Bot 私有)都有自己的判定模式(all / black / white), 见 FilterMode。
 */
export default {
	init(ctx: ServiceContext) {
		const m = new FilterManager(path.join(ctx.path.data, "filter.db"));
		m.init();
		manager = m;

		// 只拦 message.create, 其它事件一律放行
		ctx.event.filter((event, bot) => {
			if (event.type !== "message.create") return true;

			// 判定是纯内存查表: 过滤器抛错会被框架按"放行"处理, 那等于给黑名单开后门,
			// 因此这里绝不让异常逃出去(日志的失败也在 logBlocked 内部兜底)
			const ok = m.allow(event as MessageCreateEvent, bot.id);
			if (!ok) logBlocked(ctx, bot.id, event as MessageCreateEvent);
			return ok;
		});

		// 管理端点: /service/chirucat-filter/api/filter_list
		// WebUI 未启用时 ctx.core.webui 为 null, 此时只是没有管理入口, 过滤照常工作
		ctx.core.webui?.register({
			path: "filter_list",
			method: "POST",
			auth: true,
			handler: createFilterHandler({
				manager: m,
				// getter: 每次请求重新取一次设施视图, 不在插件里缓存框架对象
				get core() {
					return {
						user: ctx.core.user,
						session: ctx.core.session,
						profile: ctx.core.profile,
						bot: ctx.core.bot,
					};
				},
			}).handle,
		});

		// 管理界面: 一级导航页面 + Bot 详情窗口页面, 都指向 public/ 下自带的模块。
		// 资源路径相对本插件的 public/, URL 由框架拼装(带版本参数);
		// 注销函数同样由上下文代管 —— 服务停用后这两个入口会从导航里消失。
		ctx.core.webui?.pages.register({
			id: "global",
			title: "黑白名单",
			icon: "shield.svg",
			module: "global.js",
			styles: ["filters.css"],
			order: 50,
		});
		ctx.core.webui?.bot.pages.register({
			id: "filter",
			title: "名单",
			icon: "shield.svg",
			module: "bot.js",
			styles: ["filters.css"],
			order: 30,
		});

		// 对其他插件开放的名单能力; 框架也经这里清理被删除 Bot 的私有名单
		ctx.exports = {
			list: (scope, botId = "", targetType?) => m.list(scope, botId, targetType),
			mode: (scope, botId = "") => m.mode(scope, botId),
			setMode: (scope, botId, mode) => m.setMode(scope, botId, mode),
			add: (scope, botId, kind, targetType, target, reason = "") =>
				m.add(scope, botId, kind, targetType, target, reason),
			remove: (id: number) => m.remove(id),
			removeByBot: (botId: string) => m.removeByBot(botId),
		};
	},

	unload() {
		manager?.close();
		manager = null;
	},
} as ServiceModule;

/** 记录一条被拦下的消息: 消息不进任何处理链, 日志是唯一的可观测出口 */
function logBlocked(ctx: ServiceContext, botId: string, event: MessageCreateEvent) {
	try {
		const uinfo = ctx.core.user.query(event.senderId);
		const sinfo = ctx.core.session.query(event.sessionId);

		ctx.logger.log(
			`[过滤][${botId}][${event.platform} ${event.sessionType}:${sinfo?.id ?? event.sessionId}] ` +
			`<${event.senderName}(${uinfo?.id ?? event.senderId})> ${event.text}`,
		);
	} catch (e) {
		// 日志属于可观测性: 出错也不影响判定结果, 更不能让被拦的消息漏过去
		ctx.logger.warn(`记录过滤日志失败: ${e instanceof Error ? e.message : e}`);
	}
}
