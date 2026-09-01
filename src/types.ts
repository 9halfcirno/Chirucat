import type { WebUIServerOptions } from "./webui/server/server";

export type CoreOption = {
	/** 是否启用WebUI, 默认true */
	webui?: boolean;
	/** WebUI配置 */
	webuiOption?: WebUIServerOptions;
}