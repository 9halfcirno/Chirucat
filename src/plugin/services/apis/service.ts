import type { PluginStatus } from "../../types";
import type { ServiceHost } from "../host";
import type { Service } from "../service";

/**
 * 单个服务插件的只读快照
 *
 * 与 WebUI 的服务视图同口径(名称/版本/作者/描述/是否可配置/运行状态),
 * 但运行态用框架内部的 `PluginStatus`, 不做前端那层"registered 收敛成关"的观感处理。
 */
export type ServiceInfo = {
	id: string;
	name: string | undefined;
	version: string;
	author: string | undefined;
	description: string | undefined;
	/** 运行状态 */
	status: PluginStatus;
	/** 是否声明了配置定义, 决定有没有配置可读 */
	hasConfig: boolean;
};

/**
 * 服务插件视角的服务注册表
 *
 * 只读: 看得到有哪些服务、各自什么状态。启停不在这里 —— 服务插件的启停是有
 * 依赖连带的编排(见 `ServiceHost.setEnabled`), 由 WebUI / Core 决定, 插件拿它
 * 对着自己或同伴操作只会制造自我卸载这类结构性麻烦。
 *
 * 同样不交出 `Service` 实例: 它的 `context` / `module` / `core` 都是框架内部件;
 * 宿主用 `#host`(ECMAScript 私有)持有, 运行时也拿不到。
 */
export class ServiceAPI {
	readonly #host: ServiceHost;

	constructor(host: ServiceHost) {
		this.#host = host;
	}

	/** 全部已注册服务插件的只读快照, 按注册顺序 */
	list(): ServiceInfo[] {
		return [...this.#host.registry.values()].map(toServiceInfo);
	}

	/** 单个服务插件的只读快照; 未注册时为 null */
	get(id: string): ServiceInfo | null {
		const service = this.#host.registry.get(id);
		return service ? toServiceInfo(service) : null;
	}

	/** 该 id 的服务插件是否已注册 */
	has(id: string): boolean {
		return this.#host.registry.has(id);
	}

	/** 已启用的服务插件 id, 按注册顺序 */
	enabled(): string[] {
		return this.#host.enabledServices.map(service => service.id);
	}
}

function toServiceInfo(service: Service): ServiceInfo {
	const manifest = service.manifest;
	return {
		id: service.id,
		name: manifest.name,
		version: manifest.version,
		author: manifest.author,
		description: manifest.description,
		status: service.status,
		hasConfig: Boolean(manifest.config),
	};
}
