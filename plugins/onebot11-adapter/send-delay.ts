import type { PluginConfigAPI } from "../../src/plugin/contexts/types";
import type Logger from "../../src/utils/logger";

/**
 * 发送前随机延迟
 *
 * 平台侧会按"响应间隔过短"识别机器人, 秒回很容易触发风控。这里在
 * `message.send` 调用平台 API 之前等待一段随机时长, 模拟真人看到消息后
 * 再动手的节奏。
 *
 * 只作用于发送动作, 不影响事件接收与撤回; 延迟发生在 `callApi` 之前,
 * 因此不会被 API 超时计时器算进去。
 */

/** 随机延迟区间(ms) */
export interface SendDelayRange {
	/** 下限 */
	min: number;
	/** 上限 */
	max: number;
}

/** 默认随机延迟下限 */
export const DEFAULT_SEND_DELAY_MIN = 500;

/** 默认随机延迟上限 */
export const DEFAULT_SEND_DELAY_MAX = 1_500;

/**
 * 单次延迟硬上限(ms)
 *
 * 配置项被手改成离谱值(或上下限都很大)时兜底, 避免一个发送动作长时间挂起、
 * 调用方拿不到任何响应。
 */
export const MAX_SEND_DELAY = 60_000;

/** 读取一个非负毫秒配置项 */
function readMs(value: unknown, fallback: number): number {
	const ms = Number(value);
	if (!Number.isFinite(ms) || ms < 0) return fallback;
	return Math.min(ms, MAX_SEND_DELAY);
}

/**
 * 从插件配置读取随机发送延迟区间
 *
 * 每次发送时调用, 因此 WebUI 改完立即生效, 无需重载插件。
 * @returns null 表示未启用随机延迟
 */
export function readSendDelay(config: Pick<PluginConfigAPI, "get">): SendDelayRange | null {
	// 默认开启: 引入该配置的目的就是避免秒回被风控, 让用户主动关闭比忘记打开更安全
	if (config.get<unknown>("sendDelay", true) !== true) return null;

	const min = readMs(config.get<unknown>("sendDelayMin", DEFAULT_SEND_DELAY_MIN), DEFAULT_SEND_DELAY_MIN);
	const max = readMs(config.get<unknown>("sendDelayMax", DEFAULT_SEND_DELAY_MAX), DEFAULT_SEND_DELAY_MAX);

	// 上下限写反时交换而不是报错: 用户表达的意图仍是"在这个范围内随机"
	return min <= max ? { min, max } : { min: max, max: min };
}

/** 在区间内取一个整数毫秒值(含上下限) */
export function randomDelay(range: SendDelayRange): number {
	if (range.max <= range.min) return range.min;
	return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
}

/** 等待指定毫秒 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按配置等待一段随机时长
 *
 * 未启用或随机结果为 0 时立即返回。
 */
export async function waitSendDelay(range: SendDelayRange | null, logger?: Logger): Promise<void> {
	if (!range) return;

	const ms = randomDelay(range);
	if (ms <= 0) return;

	logger?.debug(`发送前随机延迟 ${ms}ms`);
	await sleep(ms);
}
