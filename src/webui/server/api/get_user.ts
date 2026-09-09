import type { WebUIAPI } from "../types";

export default {
	path: "get_user",

	auth: true,
	method: "POST",

	handler(req, core) {
		if (!core) throw { err: "WebUI未连接到核心", code: 503 }

		let body = req.body as Body;

		if (body.target === "accountId") {
			if (typeof body.platformId !== "string" || typeof body.platformName !== "string") throw { code: 400, err: "platform相关字段应为字符串类型" }
			let { platformName: platform, platformId: id } = body;
			if (!core.user!.has(platform, id)) throw { code: 404, err: "该用户不存在用户账号表中" }
			
			return {
				accountId: core.user!.get(platform, id)
			}
		} else if (body.target === "unionId") {
			if (typeof body.accountId !== "string") throw { code: 400, err: "字段应为字符串类型" }
			let unionId = core.user!.getUnion(body.accountId);
			return {
				unionId
			}
		} else if (body.target === "platform") {
			if (typeof body.accountId !== "string") throw { code: 400, err: "字段应为字符串类型" }
			let info = core.user!.query(body.accountId);
			return {
				platformInfo: info
			}
		}
	},
} as WebUIAPI

type Body = {
	target: "accountId";
	platformName: string;
	platformId: string;
} | {
	target: "unionId";
	accountId: string;
} | {
	target: "platform";
	accountId: string;
}