/**
 * 向统计数据库(data/statistics.db)填充随机演示数据。
 *
 * 只写 message_stat 明细表; 聚合表 message_stat_rollup 由正式运行时的
 * 降采样逻辑自动生成, 这里不手动构造。
 *
 * 用法:
 *   npx tsx scripts/seed-statistics.ts               # 追加 500 条(默认)
 *   npx tsx scripts/seed-statistics.ts 2000          # 追加 2000 条
 *   npx tsx scripts/seed-statistics.ts 500 --clear   # 先清空统计表, 再填 500 条
 */
import path from "node:path";
import { StatisticsStore } from "../src/statistics/store";
import type { StatRecord } from "../src/statistics/types";
import type { SessionType } from "../src/protocols/session";
import { uuid } from "../src/utils/uuid";

const DB_FILE = path.resolve(import.meta.dirname, "..", "data", "statistics.db");

const DAY_MS = 86_400_000;

const BOTS = ["chirucat"];

const PLATFORMS: { name: string; weight: number }[] = [
	{ name: "qq", weight: 55 },
	{ name: "discord", weight: 25 },
	{ name: "telegram", weight: 15 },
	{ name: "matrix", weight: 5 },
];

/** 指令名与其命中权重 (名字含空格的情况也一并覆盖) */
const COMMANDS: { name: string; weight: number }[] = [
	{ name: "ping", weight: 30 },
	{ name: "help", weight: 20 },
	{ name: "ai", weight: 18 },
	{ name: "bind", weight: 12 },
	{ name: "签到", weight: 12 },
	{ name: "点歌", weight: 8 },
];

const SESSION_TYPES: SessionType[] = ["private", "group", "channel"];

function pick<T>(list: T[]): T {
	return list[(Math.random() * list.length) | 0]!;
}

/** 按权重挑一项 */
function pickWeighted<T extends { weight: number }>(list: T[]): T {
	const total = list.reduce((sum, p) => sum + p.weight, 0);
	let r = Math.random() * total;
	for (const p of list) {
		r -= p.weight;
		if (r < 0) return p;
	}
	return list[0]!;
}

function randInt(min: number, max: number): number {
	return min + ((Math.random() * (max - min + 1)) | 0);
}

/** 时间偏向近期: 6 成落在最近 24 小时, 3 成落在前 1~2 天, 其余散布在最近 30 天 */
function randomTime(): number {
	const now = Date.now();
	const r = Math.random();
	if (r < 0.1) return now - randInt(0, DAY_MS);
	if (r < 0.6) return now - randInt(DAY_MS, 2 * DAY_MS);
	return now - randInt(2 * DAY_MS, 30 * DAY_MS);
}

function main() {
	const args = process.argv.slice(2);
	const clear = args.includes("--clear");
	const countArg = args.find(a => /^\d+$/.test(a));
	const count = countArg ? Number(countArg) : 500;

	const store = new StatisticsStore(DB_FILE);
	store.init();

	if (clear) {
		// 明细与聚合一起清, 只清明细会让残留的聚合数据与新增数据重复计数
		store.db.exec("DELETE FROM message_stat; DELETE FROM message_stat_rollup;");
		console.log("已清空统计表 message_stat / message_stat_rollup");
	}

	// 预生成有限数量的会话与用户, 让去重统计和排行结果更自然
	const sessionIds = Array.from({ length: 24 }, () => uuid());
	const users = Array.from({ length: 45 }, () => ({
		id: uuid(),
		unionId: Math.random() < 0.4 ? uuid() : "",
	}));

	const rows: StatRecord[] = [];
	for (let i = 0; i < count; i++) {
		const user = pick(users);
		// 约 15% 的消息命中指令: 命中指令的消息不再被过滤
		const command = Math.random() < 0.15 ? pickWeighted(COMMANDS).name : "";
		rows.push({
			time: randomTime(),
			direction: "in",
			botId: pick(BOTS),
			platform: pickWeighted(PLATFORMS).name,
			sessionId: pick(sessionIds),
			sessionType: pick(SESSION_TYPES),
			userId: user.id,
			unionId: user.unionId,
			textLen: randInt(1, 300),
			imageCount: Math.random() < 0.12 ? randInt(1, 3) : 0,
			mentionCount: Math.random() < 0.08 ? randInt(1, 5) : 0,
			filtered: !command && Math.random() < 0.05,
			isCommand: Boolean(command),
			command,
		});
	}

	// Bot 发出的消息: 数量约为收到的 6 成
	const sendCount = Math.round(count * 0.6);
	for (let i = 0; i < sendCount; i++) {
		rows.push({
			time: randomTime(),
			direction: "out",
			botId: pick(BOTS),
			platform: pickWeighted(PLATFORMS).name,
			sessionId: pick(sessionIds),
			sessionType: pick(SESSION_TYPES),
			userId: "",
			unionId: "",
			textLen: randInt(1, 400),
			imageCount: Math.random() < 0.08 ? randInt(1, 2) : 0,
			mentionCount: Math.random() < 0.1 ? randInt(1, 3) : 0,
			filtered: false,
			isCommand: false,
			command: "",
		});
	}

	store.insertMany(rows);

	const stat = store.db.prepare(`
		SELECT COUNT(*) AS c,
		       SUM(direction = 'in')  AS received,
		       SUM(direction = 'out') AS sent
		FROM message_stat
	`).get() as { c: number; received: number; sent: number };
	console.log(`已插入 ${rows.length} 条随机统计数据 (收到 ${stat.received}, 发出 ${stat.sent}), 明细表现在共 ${stat.c} 条。`);

	store.close();
}

main();
