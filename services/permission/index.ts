import type { ServiceContext } from "../../src/plugin/services/context";
import type { ServiceModule } from "../../src/plugin/services/service";
import type { User } from "../../src/entity/user";
import { PermissionLevel, type AdminEntry } from "./types";

/**
 * 向消息发送者写入权限等级
 */
function grant(sender: User, level: number): void {
	sender.permission = level;
}

/** 从配置里解析管理员 unionId 集合 */
function readAdminSet(ctx: ServiceContext): Set<string> {
	const raw = ctx.config.get<AdminEntry[]>("admins", []);
	const set = new Set<string>();
	if (!Array.isArray(raw)) return set;
	for (const entry of raw) {
		const id = entry?.unionId;
		if (typeof id === "string" && id.length > 0) set.add(id);
	}
	return set;
}

/**
 * Chirucat 权限控制服务
 *
 * 在 `before.message.handle` 阶段判定消息发送者的权限等级,
 * 写入 `msg.sender.permission`:
 *
 * | 等级 | 含义       | 来源         |
 * | ---- | ---------- | ------------ |
 * | 0    | 普通用户   | 默认         |
 * | 1    | 管理员     | 配置 `admins` |
 * | 3    | 框架持有者 | 配置 `master` |
 *
 */
export default {
	init(ctx: ServiceContext) {
		ctx.hook.register("before.message.handle", (msg) => {
			const union = msg.sender.unionId;
			if (typeof union !== "string" || union.length === 0) return;

			const master = ctx.config.get("master");
			if (typeof master === "string" && master.length > 0 && union === master) {
				grant(msg.sender, PermissionLevel.Master);
				return;
			}

			if (readAdminSet(ctx).has(union)) {
				grant(msg.sender, PermissionLevel.Admin);
				return;
			}

			grant(msg.sender, PermissionLevel.User);
		});
	},
} as ServiceModule;