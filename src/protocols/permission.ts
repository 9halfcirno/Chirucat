const Permission = {
	/** 
	 * 框架侧权限等级
	 */
	framework: {
		USER: 0,
		ADMIN: 1,
		OWNER: 3
	},

	platform: [
		// 会话
		"session.member.add",          // 会话中邀请/添加用户
		"session.member.remove",       // 踢出成员
		"session.member.mute",         // 禁言成员
		"session.member.unmute",       // 解除禁言

		"session.message.pin",         // 置顶消息
		"session.message.unpin",       // 取消置顶消息
		"session.message.create",      // 发送/创建消息(由于用户被禁言后不会产生Entity, 所以只有手动查询id才能发现没有这个权限)
		"session.message.delete",      // 撤回会话内任意消息, 而不仅限于他自己的消息

		"session.info.change",         // 更改会话信息, 如更名/编辑简介/换头像
		
		"session.announcement.create", // 发布公告
		"session.announcement.delete", // 删除公告

		"session.permission.change",   // 权限更变
		"session.delete",              // 解散/删除会话, 如群主或频道管理员
		"session.create",              // 创建会话, 通常出现在频道(guild - channel)场景
	]
}