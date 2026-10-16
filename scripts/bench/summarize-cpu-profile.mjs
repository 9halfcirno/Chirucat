/**
 * .cpuprofile 聚合: 按函数统计 self 采样耗时, 输出 Top N
 *
 * 用法: node scripts/bench/summarize-cpu-profile.mjs <profile.cpuprofile> [--top=30]
 *
 * 只做"哪个函数最贵"这一件事 —— V8 自带的时间线在这里用不上, 报告需要的是归因表格。
 */
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("用法: node scripts/bench/summarize-cpu-profile.mjs <profile.cpuprofile> [--top=30]");
	process.exit(1);
}
const top = Number((process.argv.find(a => a.startsWith("--top=")) ?? "--top=30").slice(6));

const profile = JSON.parse(fs.readFileSync(file, "utf8"));
const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const parentOf = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);

/** 去掉 file:/// 前缀、统一分隔符, 只留可读路径 */
const cleanUrl = (url) => (url || "").replace(/^file:\//, "").replace(/\\/g, "/");

/** timeDeltas 与 samples 等长: samples[i] 是进入该节点时的一拍, 之后的时长归它 */
const self = new Map();
let total = 0;
let idleUs = 0;
for (let i = 0; i < profile.samples.length; i++) {
	const dt = profile.timeDeltas[i] ?? 0;
	if (dt <= 0) continue;
	const id = profile.samples[i];
	self.set(id, (self.get(id) ?? 0) + dt);
	total += dt;
	// (idle)/(program) 是采样器在进程真的没跑 JS 时打的标记。压测的窗口里绝大部分时间是 idle,
	// 把它们算进分母会把热点稀释成 0.1% 级别, 看不出任何东西 —— 所以占比按"忙时"算
	const node = nodes.get(id);
	const name = node?.callFrame.functionName;
	if (name === "(idle)" || name === "(program)") idleUs += dt;
}
const busy = total - idleUs;

const byFunction = new Map();
for (const [id, us] of self) {
	const node = nodes.get(id);
	if (!node) continue;
	const cf = node.callFrame;
	const name = cf.functionName || "(anonymous)";
	if (name === "(idle)" || name === "(program)") continue;
	const where = cleanUrl(cf.url);
	if (!where) continue; // 原生帧由 ownerOf 归给调用它的源码函数
	const line = cf.lineNumber + 1;
	// 同一函数可能出现在多个位置(内联), 先按 函数@文件:行 聚合, 再按函数汇总
	const key = `${name}@${where.split("/").slice(-2).join("/")}:${line}`;
	const hit = byFunction.get(key) ?? { us: 0, nativeUs: 0, name, where, line };
	hit.us += us;
	byFunction.set(key, hit);
}

/**
 * 没有源位置的帧(SQLite 同步调用、控制台写入这类原生边界)如果单独成一项,
 * 热点表里最大的一格永远是 `(anonymous) @ :0`, 说明不了任何东西 ——
 * 所以把它们的时间记给最近的、有源位置的调用者, 并单独标出背了多少。
 */
const ownerOf = new Map();
function owner(id, depth = 0) {
	if (ownerOf.has(id)) return ownerOf.get(id);
	const node = nodes.get(id);
	if (!node) return null;
	const cf = node.callFrame;
	const where = cleanUrl(cf.url);
	let res;
	if (where) res = { name: cf.functionName || "(anonymous)", where, line: cf.lineNumber + 1 };
	else if (cf.functionName === "(garbage collector)") res = { name: "(garbage collector)", where: "(v8)", line: 0 };
	else if (depth > 24) res = { name: "(深层原生)", where: "(?)", line: 0 };
	else res = owner(parentOf.get(id), depth + 1) ?? { name: "(root)", where: "(root)", line: 0 };
	ownerOf.set(id, res);
	return res;
}

for (const [id, us] of self) {
	const node = nodes.get(id);
	if (!node) continue;
	const name = node.callFrame.functionName || "(anonymous)";
	if (name === "(idle)" || name === "(program)" || name === "(garbage collector)") continue;
	if (cleanUrl(node.callFrame.url)) continue;
	const o = owner(id);
	if (!o) continue;
	const key = `${o.name}@${o.where.split("/").slice(-2).join("/")}:${o.line}`;
	const hit = byFunction.get(key) ?? { us: 0, nativeUs: 0, name: o.name, where: o.where, line: o.line };
	hit.us += us;
	hit.nativeUs += us;
	byFunction.set(key, hit);
}

const rows = [...byFunction.values()].sort((a, b) => b.us - a.us).slice(0, top);

console.log(`总采样 ${total / 1000} ms (${profile.samples.length} 拍), 其中空闲/采样间隙 ${(idleUs / 1000).toFixed(1)} ms, 真正跑 JS 的时间 ${(busy / 1000).toFixed(1)} ms`);
console.log("下面两表的占比按忙时算 —— 压测窗口里绝大部分拍子落在 idle, 按总时长算会把热点稀释成看不出来的量级");
console.log("self ms 里的 原生x 是记在该函数头上的原生调用时间(SQLite 语句、控制台写入这类边界)");
console.log("self ms   忙占比  函数 @ 文件:行");
for (const r of rows) {
	const native = r.nativeUs ? `  [原生 ${(r.nativeUs / 1000).toFixed(1)}]` : "";
	console.log(
		`${(r.us / 1000).toFixed(1).padStart(8)} ${(r.us / busy * 100).toFixed(1).padStart(6)}%  ${r.name} @ ${r.where}:${r.line}${native}`,
	);
}

/** 按"文件/子系统"再汇一次: 单函数排名容易把分散在多处但同属一个模块的开销看漏 */
const byFile = new Map();
for (const r of byFunction.values()) {
	const key = r.where.includes("node_modules") ? "node_modules" : (r.where.includes("/src/") ? r.where.slice(r.where.indexOf("/src/")) : r.where.split("/").pop());
	byFile.set(key, (byFile.get(key) ?? 0) + r.us);
}
console.log("\n按模块汇总:");
for (const [file, us] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
	console.log(`${(us / 1000).toFixed(1).padStart(8)} ${(us / busy * 100).toFixed(1).padStart(6)}%  ${file}`);
}

void parentOf;
