import { StateError } from "../../../../../../errors/state-error";
import type { WebUIAPI } from "../../../../types";
import { fail, requireCore, requireRunningBot } from "../../../_shared";

/**
 * 设置Bot的插件状态
 * POST
 * 请求体
 * - bot: 目标bot id
 * - plugin: 目标插件 id
 * Future - global?: 是否为全局中的插件
 * - state: 状态, true or false
 *
 * 返回收敛后的运行态, 以及依赖连带导致状态变化的插件 id(`affected`)。
 * 启用会连带拉起它依赖的插件, 停用会连带卸载依赖它的插件 —— 前端据此
 * 逐个对齐那些卡片的开关, 不必重新扫描目录或重绘整页。
 *
 * `affected` 直接取宿主 `setEnabled` 的回报: 它算的就是本次真的被改变的插件,
 * 与写进 state.json 的是同一批 id, 界面与文件不会各说各话。
 */

const api: WebUIAPI = {
	method: "POST",
	auth: true,

	async handler(req, core) {
		const bot = requireRunningBot(requireCore(core), `${req.body.bot}`);

		const id = `${req.body.plugin}`;
		if (!bot.plugin.resolve(id)) fail(404, `目标插件不存在: ${id}`);

		const state = !!req.body.state; // 转布尔

		let result;
		try {
			// 先加载/卸载(含依赖连带), 成功后才把偏好连同连带结果写入 state.json
			result = await bot.setPluginEnabled(id, state);
		} catch (e) {
			if (e instanceof StateError) fail(409, (e as Error).message);
			fail(500, `更改插件状态失败: ${(e as Error).message}`);
		}

		return {
			success: true,
			/** 目标插件收敛后的运行态: 与 bot/state/update 一致, 前端据此对齐开关 */
			state: result.enabled,
			/** 本次被依赖连带改变的插件 id; 前端按 data.state 逐个对齐 */
			affected: result.affected,
		};
	},
}

export default api;
