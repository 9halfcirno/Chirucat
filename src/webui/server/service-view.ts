import type { Service } from "../../plugin/services/service";
import type { ServiceHost } from "../../plugin/services/host";
import { toViewStatus, type PluginViewStatus } from "./plugin-view";

/**
 * 服务插件在 WebUI 中的视图数据
 *
 * 字段与 PluginView 对齐(名称/版本/作者/描述/是否可配置/运行状态), 但少两样:
 * - 没有 scope: 服务插件只有 `services/` 一个来源, 不存在全局/Bot 私有之分
 * - type 固定为 "service": 服务页面前端不需要再判断类型
 *
 * 运行状态仍只有"开 / 关 / 切换中"三种观感, 与普通插件同一套口径。
 */
export type ServiceView = {
	id: string;
	name: string | undefined;
	version: string;
	author: string | undefined;
	description: string | undefined;
	type: "service";
	/**
	 * 是否声明了配置定义, 决定是否给出配置入口
	 *
	 * 按清单声明判断, 而不是看当前是否装配成功: 服务停用时会清空 config, 用
	 * 运行态判断会让停用后的服务再也点不开配置 —— 而读取配置的接口本就会重新装配。
	 */
	hasConfig: boolean;
	/** 运行状态, 供前端显示徽章与开关 */
	status: PluginViewStatus;
};

/** 服务插件列表接口的返回体 */
export type ServicePayload = {
	plugins: ServiceView[];
};

/** 构造服务插件列表接口的返回体 (只读快照, 不触发扫描) */
export function buildServicePayload(host: ServiceHost): ServicePayload {
	return { plugins: buildServiceViews(host) };
}

/** 构造服务插件视图列表 (只读快照, 不触发扫描, 按注册表顺序) */
export function buildServiceViews(host: ServiceHost): ServiceView[] {
	return [...host.registry.values()].map(toServiceView);
}

function toServiceView(service: Service): ServiceView {
	const manifest = service.manifest;
	return {
		id: service.id,
		name: manifest.name,
		version: manifest.version,
		author: manifest.author,
		description: manifest.description,
		type: "service",
		hasConfig: Boolean(manifest.config),
		status: toViewStatus(service.status),
	};
}
