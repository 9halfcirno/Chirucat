/**
 * 按路径读取对象属性
 *
 * 路径用点号分隔, 数组用数字下标:
 * `readProp(values, "pro-group.group-controls.0.enable")`
 *
 * 路径上任意一层为 null / undefined / 非对象时返回 undefined, 不抛错。
 *
 * @param target 目标对象
 * @param key 属性路径
 */
export function readProp(target: unknown, key: string): unknown {
	if (!key) return undefined;

	let current: unknown = target;
	for (const segment of key.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}
