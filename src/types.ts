/**
 * 启动期显式覆盖, 仅用于测试与嵌入式注入
 *
 * 正常启动的配置全部来自设置域(`configs/*.json`), 不通过这里传。这里给了的字段
 * 优先级最高, 检查脚本靠它关掉 WebUI / 统计, 或把状态文件指到临时目录。
 */
export type CoreOption = {
	/** 覆盖 core 设置域的 webui 开关 */
	webui?: boolean;
	/** 覆盖 core 设置域的 statistics 开关 */
	statistics?: boolean;
	/**
	 * 服务插件状态文件路径
	 *
	 * 缺省 `configs/services/state.json`; 嵌入式与测试场景可指到临时目录, 避免
	 * 触碰仓库里的真实状态。
	 */
	servicesStateFile?: string;
}
