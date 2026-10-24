import type { AcceptorState, Decision, DetectorInput, DetectorParams, Score } from "./types";

/**
 * 受理人判定
 *
 * 纯函数: 输入是"窗口计数 + 当前状态 + 这条事件", 输出是"放行与否 + 新状态"。
 * 不读时钟、不碰存储、不抛异常, 因此每条分支都能被自检脚本直接构造出来验证。
 *
 * ## 判定顺序
 *
 * 1. **初始化**: 没有受理人时, 第一个收到消息的适配器即受理人。
 *    单线程下事件回调串行执行, 状态写入先于返回, 因此对端的同一条消息到达时一定
 *    看得到刚写入的状态 —— "恰好一次"由此成立, 不需要延迟观察。
 *
 * 2. **受理人自己**: 放行, 并清掉 @ 连续计数。
 *
 * 3. **非受理人**, 依次:
 *    a. **抑制转移** —— 两端派发量接近时清空证据。这是稳定性的主要来源: 群里正常
 *       说话时两端都会派发, 差值天然在噪声范围内, 不该被当成故障。
 *    b. **@ 快速通道** —— 挑战者被 @ 且受理人彻底没动静, 连续 N 次立即转移。
 *       这是唯一能压缩"受理人已死但阈值还没攒够"真空期的手段。
 *    c. **异常确认** —— 受理人沉默且挑战者有足够样本, 或低速率兜底差距够大,
 *       证据 +1; 超过转移阈值才真的转移。
 *    d. **回切** —— 当前受理人是转移来的, 且挑战者(原受理人)复活并严格超过它。
 *       阈值更高, 且冷却期内不采纳。
 *
 * ## 为什么转移与回切用两套阈值
 *
 * 转移是"救火": 受理人死了就没响应, 证据攒够就该动。回切是"收复": 现任还在正常
 * 工作, 贸然切回去只会引入抖动, 所以要求更高的门槛与更长的观察。方向非对称也
 * 体现在这里 —— 只有"受理人沉默"才累积转移证据, 反向不触发; 回切单独一套。
 */
export function evaluate(params: DetectorParams, input: DetectorInput): Decision {
	const { at, adapter } = input;

	// ---------- 1. 初始化 ----------
	if (!input.state) {
		return {
			allow: true,
			state: {
				acceptor: adapter,
				since: at,
				scores: {},
				fastStreak: 0,
				cooldownUntil: 0,
				transfers: 0,
			},
			transferred: true,
			reason: "初始化: 首个派发的适配器成为受理人",
		};
	}

	const state = clone(input.state);
	const acceptor = state.acceptor;

	// ---------- 2. 受理人自己 ----------
	if (adapter === acceptor) {
		state.fastStreak = 0;
		return { allow: true, state, transferred: false, reason: "受理人放行" };
	}

	// ---------- 3. 非受理人 ----------
	const cA = input.counts[acceptor] ?? 0;
	const cB = input.counts[adapter] ?? 0;
	const maxCount = Math.max(cA, cB);
	const score = (state.scores[adapter] ??= { transfer: 0, switchBack: 0 });

	// 3a. 抑制转移: 两端接近, 不是故障
	if (cA + cB >= params.minSamples
		&& Math.abs(cA - cB) < Math.max(params.minAbsoluteGap, params.relativeGap * maxCount)) {
		score.transfer = 0;
		score.switchBack = 0;
		// 两端都正常 → 之前累积的 @ 连续计数也不再成立
		state.fastStreak = 0;
		return {
			allow: false,
			state,
			transferred: false,
			reason: `抑制转移: 两端派发量接近(${acceptor}=${cA}, ${adapter}=${cB})`,
		};
	}

	// 3b. @ 快速通道: 挑战者被 @, 受理人彻底没动静
	const lastAcceptorProbe = input.lastProbeAt[acceptor];
	const acceptorSilentFor = lastAcceptorProbe === undefined ? Number.POSITIVE_INFINITY : at - lastAcceptorProbe;
	const fastSilent = acceptorSilentFor >= params.fastPath.silenceMs;

	if (params.fastPath.enabled && input.mentionedSelf === true && fastSilent) {
		state.fastStreak++;
		if (state.fastStreak >= params.fastPath.consecutive) {
			return transfer(state, adapter, at, params, `@ 快速通道: ${adapter} 连续 ${state.fastStreak} 次被 @ 而 ${acceptor} 无派发`);
		}
		return {
			allow: false,
			state,
			transferred: false,
			reason: `@ 快速通道计数 ${state.fastStreak}/${params.fastPath.consecutive}`,
		};
	}

	// 条件不成立: 连续性被打断
	state.fastStreak = 0;

	// 3c. 异常确认: 受理人沉默, 或低速率下差距够大
	const acceptorSilent = cA <= params.silenceThreshold;
	const gapEnough = cB - cA >= params.absoluteGap;
	const strictlyBetter = gapEnough && cB - cA >= params.relativeGap * maxCount;
	const inCooldown = at < state.cooldownUntil;

	if (acceptorSilent) {
		// 受理人已经没消息了 —— 救火路径, 门槛低
		if (cB >= params.minSamples) score.transfer++;
		else if (gapEnough) score.transfer++;

		if (score.transfer > params.transferThreshold) {
			return transfer(
				state,
				adapter,
				at,
				params,
				`转移: ${acceptor} 沉默(cA=${cA}), ${adapter} 活跃(cB=${cB}), 证据 ${score.transfer}/${params.transferThreshold}`,
			);
		}
	} else if (gapEnough) {
		// 受理人还活着但差距足够大: 是回切还是换人?
		// 现任由转移而来、原受理人复活且严格超过 → 回切(门槛更高)
		if (state.transfers > 0 && !inCooldown && strictlyBetter) {
			score.switchBack++;
			if (score.switchBack > params.switchBackThreshold) {
				return transfer(
					state,
					adapter,
					at,
					params,
					`回切: ${adapter} 严格超过 ${acceptor}(cA=${cA}, cB=${cB}), 证据 ${score.switchBack}/${params.switchBackThreshold}`,
				);
			}
		} else {
			// 低速率兜底: 样本没攒够, 但差距本身已经足够说明问题
			score.transfer++;
			if (score.transfer > params.transferThreshold) {
				return transfer(
					state,
					adapter,
					at,
					params,
					`转移: ${acceptor} 落后(cA=${cA}), ${adapter} 领先(cB=${cB}), 证据 ${score.transfer}/${params.transferThreshold}`,
				);
			}
		}
	}

	return {
		allow: false,
		state,
		transferred: false,
		reason: `非受理人, 证据 transfer=${score.transfer} switchBack=${score.switchBack}`,
	};
}

/** 执行一次受理人变更: 换人、清空证据、进入冷却 */
function transfer(
	state: AcceptorState,
	to: string,
	at: number,
	params: DetectorParams,
	reason: string,
): Decision {
	state.acceptor = to;
	state.since = at;
	state.scores = {};
	state.fastStreak = 0;
	state.cooldownUntil = at + params.cooldownMs;
	state.transfers++;

	return { allow: true, state, transferred: true, reason };
}

function clone(state: AcceptorState): AcceptorState {
	const scores: Record<string, Score> = {};
	for (const [adapter, score] of Object.entries(state.scores)) {
		scores[adapter] = { transfer: score.transfer, switchBack: score.switchBack };
	}

	return { ...state, scores };
}
