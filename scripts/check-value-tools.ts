/**
 * JSON 值工具自检
 *
 * 状态管理重构第 4 批: 把原先两份语义不一致的 `deepEqual` 收敛到
 * `src/config/store.ts` 唯一一份实现, 这里直接钉住它的语义边界,
 * 并防止旧实现(`src/utils/deepEqual.ts`)被重新引入。
 *
 * 重点: 数组顺序敏感、数组与对象不相等、**键名要对得上**、
 * `undefined` 键与缺失键不相等、对象键顺序不敏感。
 *
 * 用法:
 *   npx tsx scripts/check-value-tools.ts
 *
 * 纯内存, 不创建文件; 退出码 0 表示全部通过。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { cloneValue, deepEqual, isPlainObject } from "../src/config/store";
import { root } from "../src/utils/root";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ""}`);
	}
}

console.log("\n[deepEqual 语义]");
check("原始类型相等", deepEqual(1, 1) && deepEqual("a", "a") && deepEqual(null, null));
check("原始类型不等", !deepEqual(1, 2) && !deepEqual(1, "1") && !deepEqual(null, {}));
check("数组顺序敏感", deepEqual([1, 2], [1, 2]) && !deepEqual([1, 2], [2, 1]));
check("数组长度不同不相等", !deepEqual([1], [1, 2]));
check("数组与类数组对象不相等", !deepEqual(["a"], { 0: "a" }));
check("对象键顺序不敏感", deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
check("对象嵌套递归比较", deepEqual({ a: { b: [1, { c: true }] } }, { a: { b: [1, { c: true }] } }));
check("嵌套差异能被检出", !deepEqual({ a: { b: 1 } }, { a: { b: 2 } }));
check("键名不同即使值相同也不相等", !deepEqual({ x: undefined }, { y: undefined }));
check("undefined 键与缺失键不相等", !deepEqual({ x: undefined }, {}));
check("补一个键能被检出", !deepEqual({}, { x: undefined }));
check("NaN 不在输入域内, 按!==处理", !deepEqual(NaN, NaN));

console.log("\n[值工具]");
const source = { a: [1, { b: 2 }], c: 3 };
const cloned = cloneValue(source);
check("cloneValue 是深拷贝", cloned !== source && cloned.a !== source.a && (cloned.a[1] as object) !== source.a[1]);
check("cloneValue 内容一致", deepEqual(cloned, source));
check("isPlainObject 排除 null 与数组",
	isPlainObject({}) && !isPlainObject(null) && !isPlainObject([]) && !isPlainObject(1));

console.log("\n[唯一实现]");
const legacy = path.join(root, "src", "utils", "deepEqual.ts");
let legacyExists = true;
try {
	await fs.access(legacy);
} catch {
	legacyExists = false;
}
check("旧的重复实现已删除", !legacyExists);
const hostSource = await fs.readFile(path.join(root, "src", "plugin", "managed-host.ts"), "utf-8");
check("插件宿主引用 store 的实现", hostSource.includes('from "../config/store"') && !hostSource.includes("utils/deepEqual"));

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
