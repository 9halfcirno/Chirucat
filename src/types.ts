import type { WebUIServerOptions } from "./webui/server/server";
import type { StatisticsOptions } from "./statistics/types";

export type CoreOption = {
	/** 是否启用WebUI, 默认true */
	webui?: boolean;
	/** WebUI配置 */
	webuiOption?: WebUIServerOptions;
	/** 是否启用业务数据统计, 默认true */
	statistics?: boolean;
	/** 统计配置 */
	statisticsOption?: StatisticsOptions;
}