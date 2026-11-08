import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const [, , distArg, srcArg, ...rest] = process.argv;

if (!distArg || !srcArg) {
	console.error("用法: node scripts/run.mjs <distFile> <srcFile> [args...]");
	process.exit(1);
}

const distFile = resolve(distArg);
const srcFile = resolve(srcArg);

const useNode = process.env.FORCE_TSX
	? false
	: process.env.FORCE_JS
		? true
		: existsSync(distFile);

const args = useNode
	? [distFile, ...rest]
	: ["--import", "tsx", srcFile, ...rest];

const child = spawn(process.execPath, args, { stdio: "inherit" });

/** 子进程自行退出的宽限(ms): 与 app.ts 的关闭超时同量级, 超时视为关闭流程卡死 */
const CLOSE_GRACE = 10_000;

/**
 * 信号一律不转发, 只当看门狗
 *
 * Ctrl+C 是控制台级别的事件, 同一控制台/进程组里的子进程自己就收得到 SIGINT,
 * 包装进程再 `child.kill(sig)` 纯属多余, 而且在 Windows 上那就是 TerminateProcess:
 * 子进程刚打出一句"正在退出"就被当场掐死, 优雅关闭的日志与收尾一步都跑不到。
 * 这里改成等子进程自己退出, 只有超过宽限才兜底结束它。
 */
let watchdog = null;

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		if (watchdog) return;
		watchdog = setTimeout(() => {
			console.error(`[run] 子进程未在 ${CLOSE_GRACE}ms 内退出, 强制结束`);
			child.kill();
		}, CLOSE_GRACE);
	});
}

child.on("exit", (code, signal) => {
	if (watchdog) clearTimeout(watchdog);
	process.exitCode = code ?? (signal ? 1 : 0);
});
