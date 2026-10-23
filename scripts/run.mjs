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

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => child.kill(sig));
}

child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal ? 1 : 0);
});