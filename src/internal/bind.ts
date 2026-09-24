/**
 * 提供Bind功能, 使绑定两个不同账号
 * 
 * @internal 内部临时实现，未来将重构并下沉为普通插件服务
 * @todo 待重构: 日后抽离为 Service插件
 * 
 */

import { TTLMap } from "../utils/ttl-map";
import { uuid } from "../utils/uuid";
import type { UserManager } from "./user-manager";

export class BindManager {
	/** token -> aid 映射 */
	tokens = new TTLMap<string, string>();
	/** aid -> token 反向映射，用于保证同一 aid 重新生成时刷新旧 token */
	aidToToken = new TTLMap<string, string>();

	constructor(private um: UserManager) { }

	/**
	 * 获取新的 bind token
	 * 如果该 aid 已存在可用 token，会将其刷新（擦除旧 token 并生成新的）
	 * @param aid 发起绑定的账号 uuid
	 * @param ttl 有效期毫秒数（默认 5 分钟）
	 */
	new(aid: string, ttl: number = 5 * 60 * 1000): string {
		// 1. 若当前 aid 已存在未过期的旧 token，先行擦除旧 token
		const oldToken = this.aidToToken.get(aid);
		if (oldToken) {
			this.tokens.delete(oldToken);
			this.aidToToken.delete(aid);
		}

		// 2. 生成新 token
		const token = uuid();

		// 3. 写入双向映射
		this.tokens.set(token, aid, ttl);
		this.aidToToken.set(aid, token, ttl);

		return token;
	}

	/**
	 * 使用 token 消费绑定：将当前账号 (targetAid) 与 token 对应的源账号 (sourceAid) 合并至同一组
	 * @param targetAid 提交/消费 token 的目标账号 uuid
	 * @param token 验证码
	 * @returns 绑定结果消息
	 */
	bind(targetAid: string, token: string): { success: boolean; message: string } {
		// 1. 获取并清理 token（单次消费）
		const sourceAid = this.tokens.get(token);
		if (!sourceAid) {
			return { success: false, message: "绑定令牌无效或已过期！" };
		}

		// 2. 擦除映射关系，防止二次消费
		this.tokens.delete(token);
		this.aidToToken.delete(sourceAid);

		// 3. 边界校验：不能绑定自身
		if (sourceAid === targetAid) {
			return { success: false, message: "不能将账号绑定到其自身！" };
		}

		// 4. 获取源账号的组 ID (internal_id)
		const sourceInternalId = this.um.getUnion(sourceAid);
		if (!sourceInternalId) {
			return { success: false, message: "源账号不存在或获取跨平台ID失败！" };
		}

		// 5. 将目标账号 (targetAid) 绑定至源账号所在的 internal_id 组中
		this.um.bind(sourceInternalId, targetAid);

		return { success: true, message: "账号绑定成功！" };
	}
}