export interface PluginHelper {
	/**
	 * 从指定链接下载插件
	 * @param url 目标插件所在的目录
	 */
	download(url: string | URL): Promise<void>;


}