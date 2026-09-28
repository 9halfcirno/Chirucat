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
	/**
	 * 服务插件状态文件路径
	 *
	 * 缺省 `configs/services/state.json`; 嵌入式与测试场景可指到临时目录, 避免
	 * 触碰仓库里的真实状态。
	 */
	servicesStateFile?: string;
}